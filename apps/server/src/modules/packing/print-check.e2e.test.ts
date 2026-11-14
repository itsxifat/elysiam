import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service.js';
import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import {
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { BookingService } from '../courier/booking.service.js';
import { COURIER_QUEUE_DEFINITIONS } from '../courier/courier.queues.js';
import { REBOOK_BY } from '../courier/courier.repository.js';
import { applyCourierMigrations, makeCourier } from '../courier/courier.testing.js';
import { FILES_QUEUE_DEFINITIONS } from '../files/files.queues.js';
import type { GotenbergClient } from '../files/pdf/gotenberg.client.js';
import { IAM_API } from '../iam/iam.api.js';
import { seedProductWithSkus, warehouseId } from '../inventory/inventory.testing.js';
import { ORDERS_API } from '../orders/orders.api.js';
import { applyOrderMigrations, seedCustomer, seedStockLevel } from '../orders/orders.testing.js';
import { ParcelObserverRegistry } from '../orders/ports/parcel-observer.port.js';
import { PACKING_QUEUE_DEFINITIONS } from './packing.queues.js';
import { registerPackingJobs } from './packing.worker.js';
import { encodePng } from './printers/png.js';
import type { PrinterTransport } from './printers/transport.js';
import { PrintingService } from './printing.service.js';
import { TerminalsService } from './terminals.service.js';
import { PackingVideoService } from './video.service.js';

/**
 * The owner's two reports of 2026-11-13, on real Postgres:
 *
 * 1. **An unbooked order reached packing** (D-1024). A packing slip printed for an order still
 *    waiting for its booking moved it to Packaging's "To pack", and the Orders page printed a
 *    label that said "Not booked". Now only a printed label with its consignment moves an order
 *    to "To pack", and the Orders page refuses an unbooked order's label. A booking that ran out
 *    of retries because the courier did not answer is booked again by the quarter-hour sweep
 *    (Steadfast's timeouts of 2026-11-11), without a fresh alert each time.
 * 2. **A print that did not come out** (D-1025). The print station can only say Chrome's print
 *    finished; a jammed printer still "printed" every label and they left Ready for label for
 *    good. A person can now put a printed page back: it is `failed`, the order is in Ready for
 *    label and out of "To pack", and printing it again needs no reason. Not for a packed order.
 *
 * The print sender runs for real (pg-boss, a recording printer on a LAN address, a stand-in
 * Gotenberg), as in `labels.e2e.test.ts`.
 */

let harness: HttpHarness;
let jobs: JobsRuntime | undefined;
let admin: RoleClient;
let location = '';
let customerId = '';
let courierId = '';
let accountId = '';
let skuId = '';

const transport: PrinterTransport = {
  sendRaw: () => Promise.resolve(),
  probeRaw: () => Promise.resolve(true),
  ipp: () => Promise.reject(new Error('no IPP printer in this suite')),
};

const gotenberg = {
  renderPdf: () => Promise.resolve(new TextEncoder().encode('%PDF-1.7 test page')),
  screenshotPng: (request: { width?: number; height?: number }) => {
    const width = request.width ?? 100;
    const height = request.height ?? 100;
    return Promise.resolve(
      encodePng({ width, height, channels: 1, data: new Uint8Array(width * height).fill(255) }),
    );
  },
  isReady: () => Promise.resolve(true),
} as unknown as GotenbergClient;

type Json = Record<string, unknown>;

async function call(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: Json; text: string }> {
  const response = await admin.client.request(method, url, body === undefined ? {} : { body });
  let parsed: Json;
  try {
    parsed = response.body === '' ? {} : (JSON.parse(response.body) as Json);
  } catch {
    parsed = {};
  }
  return { status: response.statusCode, body: parsed, text: response.body };
}

async function until(check: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting');
}

async function confirmedOrder(): Promise<{ id: string; orderNo: string }> {
  const created = await call('POST', '/v1/orders', {
    channel: 'phone',
    customerId,
    locationId: location,
    courierId,
    deliveryChargePoisha: '6000',
    lines: [{ skuId, qty: 1, unitPricePoisha: '150000' }],
  });
  expect(created.status, created.text).toBe(201);
  const id = String(created.body.id);
  const confirmed = await call('POST', `/v1/orders/${id}/confirm`);
  expect(confirmed.status, confirmed.text).toBe(201);
  return { id, orderNo: String(created.body.orderNumber ?? created.body.orderNo) };
}

/** The courier's booking transaction telling packing the parcel has its consignment. */
async function booked(orderId: string): Promise<string> {
  const consignmentNo = `SF${randomUUID().slice(0, 8).toUpperCase()}`;
  const registry = harness.app.get(ParcelObserverRegistry, { strict: false });
  await withOrg({ orgId: ORG_A, userId: 'usr_courier_worker' }, (tx) =>
    registry.notify(tx, { orgId: ORG_A, orderId, consignmentNo, at: new Date() }),
  );
  return consignmentNo;
}

interface JobView {
  readonly id: string;
  readonly document: string;
  readonly state: string;
  readonly lastError: string | null;
}

async function jobsOf(orderId: string): Promise<JobView[]> {
  const page = await call('GET', `/v1/labels/jobs?orderId=${orderId}&limit=200`);
  expect(page.status, page.text).toBe(200);
  return page.body.items as JobView[];
}

async function print(orderId: string, document: 'label' | 'packing_slip', reason?: string) {
  return call('POST', '/v1/labels/print', {
    orderIds: [orderId],
    documents: [document],
    ...(reason === undefined ? {} : { reason }),
  });
}

/** Printed by the worker's sender: every job of the order and document `printed`. */
async function printedAll(orderId: string, document: string): Promise<void> {
  await until(async () => {
    const mine = (await jobsOf(orderId)).filter((job) => job.document === document);
    return mine.length > 0 && mine.every((job) => job.state === 'printed');
  });
}

async function slipPrintedAt(orderId: string): Promise<Date | null> {
  const [row] = await withSystem(
    (tx) =>
      tx.execute<{ slip_printed_at: Date | null }>(sql`
        select slip_printed_at from sales.orders where org_id = ${ORG_A} and id = ${orderId}
      `),
    { orgId: ORG_A },
  );
  return row?.slip_printed_at ?? null;
}

async function readyHas(orderId: string): Promise<boolean> {
  const ready = await call('GET', '/v1/labels/ready');
  expect(ready.status, ready.text).toBe(200);
  return (ready.body.items as { orderId: string }[]).some((item) => item.orderId === orderId);
}

beforeAll(async () => {
  harness = await startHttpHarness('print-check');
  await applyOrderMigrations();
  await applyCourierMigrations();
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: [
      ...FILES_QUEUE_DEFINITIONS,
      ...PACKING_QUEUE_DEFINITIONS,
      ...COURIER_QUEUE_DEFINITIONS,
    ],
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });
  const printing = new PrintingService(
    harness.app.get(ORDERS_API, { strict: false }),
    harness.app.get(IAM_API, { strict: false }),
    transport,
    gotenberg,
    harness.app.get(TerminalsService, { strict: false }),
    harness.app.get(AuditService, { strict: false }),
  );
  await registerPackingJobs({
    jobs,
    videos: harness.app.get(PackingVideoService, { strict: false }),
    printing,
    report: () => Promise.resolve(),
  });

  admin = await harness.asRole('org_admin', ORG_A);
  location = await warehouseId(ORG_A);
  customerId = await seedCustomer(ORG_A, { phoneE164: '+8801711987002', name: 'Nasrin Sultana' });
  const { skus } = await seedProductWithSkus(ORG_A, `pc${randomUUID().slice(0, 6)}`, 1);
  const [sku] = skus;
  if (sku === undefined) throw new Error('no SKU seeded');
  skuId = sku.id;
  await seedStockLevel(ORG_A, { skuId, locationId: location, qty: 200, unitCostPoisha: 40_000n });
  courierId = await makeCourier(ORG_A, 'fake', 'Fake Courier');
  const [account] = await withSystem(
    (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into courier.courier_accounts
          (org_id, courier_id, provider_code, label, supports_webhook, verified, is_active)
        values (${ORG_A}, ${courierId}, 'fake', 'Print check courier', true, true, true)
        on conflict (org_id, courier_id) do update set label = excluded.label
        returning id
      `),
    { orgId: ORG_A },
  );
  accountId = account?.id ?? '';

  const terminal = await call('POST', '/v1/terminals', { kind: 'label', name: 'Label check' });
  expect(terminal.status, terminal.text).toBe(201);
  const printer = await call('POST', '/v1/labels/printers', {
    terminalId: String(terminal.body.id),
    name: 'Label check · TSC',
    connection: 'raw',
    language: 'tspl',
    host: '192.168.250.11',
    port: 9100,
    medium: '4x6',
    documents: ['label', 'packing_slip'],
  });
  expect(printer.status, printer.text).toBe(201);
  await printing.probeAll();
}, 420_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 60_000);

describe('an unbooked order does not reach packing (D-1024)', () => {
  it('moves an order to "To pack" only once its booked label prints, never on a slip', async () => {
    const order = await confirmedOrder();
    // Not booked: the label is refused, and a slip prints without moving the order on.
    const label = await print(order.id, 'label');
    expect(label.status, label.text).toBe(409);
    expect(label.body.code).toBe('LABEL_NOT_BOOKED');
    expect((await print(order.id, 'packing_slip')).status).toBe(200);
    await printedAll(order.id, 'packing_slip');
    expect(await slipPrintedAt(order.id)).toBeNull();
    const toPack = await call('GET', `/v1/orders?queue=hub_packing&limit=100`);
    expect((toPack.body.items as { id: string }[]).some((one) => one.id === order.id)).toBe(false);

    // Booked: its label prints and the order is in "To pack".
    await booked(order.id);
    expect((await print(order.id, 'label')).status).toBe(200);
    await printedAll(order.id, 'label');
    expect(await slipPrintedAt(order.id)).not.toBeNull();
  });

  it('refuses the Orders page’s label PDF for an order not booked yet', async () => {
    const order = await confirmedOrder();
    const pdf = await call('GET', `/v1/orders/documents?ids=${order.id}&kind=label`);
    expect(pdf.status, pdf.text).toBe(409);
    expect(pdf.body.code).toBe('LABEL_NOT_BOOKED');
    const single = await call('GET', `/v1/orders/${order.id}/document?kind=label`);
    expect(single.status, single.text).toBe(409);
  });

  it('books again a booking the courier never answered, for a day, and alerts only once', async () => {
    const insertFailed = async (
      orderId: string,
      orderNo: string,
      options: { code: string; message?: string; createdHoursAgo?: number; by?: string },
    ) =>
      withSystem(
        async (tx) => {
          // This suite books on Confirm: the order's own booking becomes the failed one.
          const updated = await tx.execute(sql`
            update courier.consignments
               set booking_state = 'failed', booking_attempts = 6,
                   booking_failure_code = ${options.code},
                   booking_failure_message = ${options.message ?? 'Every booking attempt failed.'},
                   created_by = ${options.by ?? 'usr_x'},
                   created_at = now() - make_interval(hours => ${options.createdHoursAgo ?? 1}),
                   updated_at = now() - interval '20 minutes'
             where org_id = ${ORG_A} and order_id = ${orderId}
            returning id
          `);
          if (updated.length > 0) return;
          await tx.execute(sql`
            insert into courier.consignments
              (org_id, order_id, courier_account_id, courier_id, reference, booking_state,
               booking_attempts, booking_failure_code, booking_failure_message, cod_amount_poisha,
               created_by, created_at, updated_at)
            values (${ORG_A}, ${orderId}, ${accountId}, ${courierId}, ${orderNo}, 'failed', 6,
              ${options.code}, ${options.message ?? 'Every booking attempt failed.'}, 156000, ${options.by ?? 'usr_x'},
              now() - make_interval(hours => ${options.createdHoursAgo ?? 1}),
              now() - interval '20 minutes')
          `);
        },
        { orgId: ORG_A },
      );
    const consignments = async (orderId: string) =>
      withSystem(
        (tx) =>
          tx.execute<{ booking_state: string; created_by: string }>(sql`
            select booking_state::text, created_by from courier.consignments
            where org_id = ${ORG_A} and order_id = ${orderId} order by created_at
          `),
        { orgId: ORG_A },
      );

    const timedOut = await confirmedOrder();
    await insertFailed(timedOut.id, timedOut.orderNo, { code: 'COURIER_BOOKING_FAILED' });
    const refused = await confirmedOrder();
    // A courier's refusal: the same code, with the adapter's own sentence (ledger audit W1).
    await insertFailed(refused.id, refused.orderNo, {
      code: 'COURIER_BOOKING_FAILED',
      message: 'Steadfast refused the parcel (400).',
    });
    // Cancelled after its booking failed: never booked again, by the sweep or a person (C1).
    const cancelled = await confirmedOrder();
    await insertFailed(cancelled.id, cancelled.orderNo, { code: 'COURIER_BOOKING_FAILED' });
    const cancel = await call('POST', `/v1/orders/${cancelled.id}/cancel`, {
      reason: 'The buyer cancelled',
    });
    expect(cancel.status, cancel.text).toBeLessThan(300);
    const old = await confirmedOrder();
    await insertFailed(old.id, old.orderNo, {
      code: 'COURIER_BOOKING_FAILED',
      createdHoursAgo: 30,
    });

    const booking = harness.app.get(BookingService, { strict: false });
    expect(await booking.rebookFailed()).toBeGreaterThanOrEqual(1);
    const again = await consignments(timedOut.id);
    expect(again.map((row) => row.booking_state)).toEqual(['failed', 'pending']);
    expect(again[1]?.created_by).toBe(REBOOK_BY);
    // A courier's refusal needs a person; a day after the first booking the sweep stops.
    expect((await consignments(refused.id)).map((row) => row.booking_state)).toEqual(['failed']);
    expect((await consignments(old.id)).map((row) => row.booking_state)).toEqual(['failed']);
    expect((await consignments(cancelled.id)).map((row) => row.booking_state)).toEqual(['failed']);
    const bookAgain = await call('POST', '/v1/courier/parcels/bulk', { orderIds: [cancelled.id] });
    expect(bookAgain.status, bookAgain.text).toBe(201);
    expect(bookAgain.body.results).toMatchObject([
      { orderId: cancelled.id, enqueued: false, code: 'CONSIGNMENT_INVALID' },
    ]);
    expect((await consignments(cancelled.id)).map((row) => row.booking_state)).toEqual(['failed']);

    // The re-booking fails again: recorded, no second alert.
    const [pending] = await withSystem(
      (tx) =>
        tx.execute<{ id: string }>(sql`
          select id from courier.consignments
          where org_id = ${ORG_A} and order_id = ${timedOut.id} and booking_state = 'pending'
        `),
      { orgId: ORG_A },
    );
    const alerts = async () => {
      const [row] = await withSystem(
        (tx) =>
          tx.execute<{ n: number }>(sql`
            select count(*)::int as n from events.outbox
            where org_id = ${ORG_A} and name = 'delivery.booking_failed'
              and payload->>'orderId' = ${timedOut.id}
          `),
        { orgId: ORG_A },
      );
      return row?.n ?? 0;
    };
    const before = await alerts();
    await booking.reportBookingFailed({
      orgId: ORG_A,
      consignmentId: pending?.id ?? '',
      code: 'COURIER_BOOKING_FAILED',
    });
    expect((await consignments(timedOut.id)).map((row) => row.booking_state)).toEqual([
      'failed',
      'failed',
    ]);
    expect(await alerts()).toBe(before);
  });
});

describe('a print that did not come out goes back (D-1025)', () => {
  it('puts a printed label back in Ready for label, out of "To pack", printed again without a reason', async () => {
    const order = await confirmedOrder();
    await booked(order.id);
    expect((await print(order.id, 'label')).status).toBe(200);
    await printedAll(order.id, 'label');
    expect(await readyHas(order.id)).toBe(false);
    expect(await slipPrintedAt(order.id)).not.toBeNull();
    const [job] = await jobsOf(order.id);
    if (job === undefined) throw new Error('no job');

    const back = await call('POST', '/v1/labels/jobs/not-printed', { jobIds: [job.id] });
    expect(back.status, back.text).toBe(200);
    expect(back.body).toMatchObject({ jobIds: [job.id], orderIds: [order.id] });
    const [after] = await jobsOf(order.id);
    expect(after).toMatchObject({ state: 'failed' });
    expect(after?.lastError).toMatch(/did not come out of the printer/i);
    expect(await readyHas(order.id)).toBe(true);
    expect(await slipPrintedAt(order.id)).toBeNull();

    // Printing it again is not a reprint: no reason asked.
    expect((await print(order.id, 'label')).status).toBe(200);
    await until(async () => (await jobsOf(order.id)).some((one) => one.state === 'printed'));
    expect(await readyHas(order.id)).toBe(false);

    // A page already put back, or a page that is not printed, cannot be put back again.
    const twice = await call('POST', '/v1/labels/jobs/not-printed', { jobIds: [job.id] });
    expect(twice.status, twice.text).toBe(409);
    expect(twice.body.code).toBe('PRINT_JOB_STATE');
    expect(
      (await call('POST', '/v1/labels/jobs/not-printed', { jobIds: [randomUUID()] })).status,
    ).toBe(404);
  });

  it('keeps a finished job otherwise as it happened', async () => {
    const order = await confirmedOrder();
    await booked(order.id);
    expect((await print(order.id, 'label')).status).toBe(200);
    await printedAll(order.id, 'label');
    const [job] = await jobsOf(order.id);
    // Any change but the one move back is refused by the database (migration 0179).
    const refused = await withSystem(
      (tx) =>
        tx.execute(sql`
          update packing.print_jobs set attempts = attempts + 1
          where org_id = ${ORG_A} and id = ${job?.id ?? ''}
        `),
      { orgId: ORG_A },
    ).then(
      () => '',
      (error: unknown) =>
        String(
          error instanceof Error && error.cause instanceof Error ? error.cause.message : error,
        ),
    );
    expect(refused).toMatch(/finished print job/);
  });
});

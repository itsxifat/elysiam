import { createHash, randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { attachScope } from '../../platform/auth/scope.js';
import { open, seal } from '../../platform/crypto/sealed-box.js';
import type { ActiveContext } from '../../platform/http/context.js';
import type { DeliveredEvent } from '../../platform/events/dispatcher.js';
import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { seedProductWithSkus, warehouseId } from '../inventory/inventory.testing.js';
import { sealToken } from '../marketing/credentials.js';
import { MARKETPLACE_QUEUE_DEFINITIONS } from '../marketplace/marketplace.queues.js';
import { NOTIFY_QUEUES } from '../notify/notify.queues.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { OrdersService } from '../orders/orders.service.js';
import {
  applyOrderMigrations,
  ownRiderCourier,
  seedCustomer,
  seedOrder,
  seedStockLevel,
} from '../orders/orders.testing.js';
import { signStorefront } from '../storefront/signature.js';
import { STOREFRONT_QUEUE_DEFINITIONS } from '../storefront/storefront.queues.js';
import { insertTestSiteKey, type TestSiteKey } from '../storefront/storefront.testing.js';
import { upsertTrackingSettings } from '../storefront/web-marketing.repository.js';
import { TrackingDeliveries, TrackingRetryLater } from './delivery.service.js';
import { TrackingOrderEvents } from './order-events.service.js';
import { FakeTrackingGateway, TRACKING_GATEWAY } from './providers/gateway.js';
import { TrackingSetupService } from './setup.service.js';
import { TRACKING_API, type TrackingApi } from './tracking.api.js';
import { TRACKING_QUEUE_DEFINITIONS } from './tracking.queues.js';
import { bindings } from './tracking-state.js';

/**
 * The tracking hub on real Postgres (M54, D-957 to D-969): Settings → Tracking with its secrets
 * sealed and its ids the org admin's; every channel's order making one Purchase at confirmation
 * however often the outbox repeats itself; the website's signals carried to that Purchase and
 * its campaign onto the order; GA4's refunds; one delivery per platform with its own retry; the
 * one-time import of the old screens; and another brand seeing none of it.
 */

let harness: HttpHarness;
let jobs: JobsRuntime | undefined;
let admin: RoleClient;
let marketing: RoleClient;
let sales: RoleClient;
let adminB: RoleClient;
let key: TestSiteKey;
let gateway: FakeTrackingGateway;
let events: TrackingOrderEvents;
let deliveries: TrackingDeliveries;
let setup: TrackingSetupService;
let hub: TrackingApi;
let orders: OrdersApi;
let skuId = '';
let skuCode = '';
let customerId = '';
let area = { districtId: 0, thanaId: 0 };
const suffix = randomUUID().slice(0, 6);
const TOKEN = 'EAAB-hub-test-access-token-never-real-0001';
const API_SECRET = 'ga4-hub-secret-test-0001';
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

async function signed(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  idempotencyKey?: string,
) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await harness.server.inject({
    method,
    url: path,
    headers: {
      'x-api-key': key.keyId,
      'x-api-timestamp': timestamp,
      'x-api-signature': signStorefront(key.secret, {
        timestamp,
        method,
        pathAndQuery: path,
        ...(raw === undefined ? {} : { idempotencyKey: idempotencyKey ?? '', rawBody: raw }),
      }),
      ...(raw === undefined ? {} : { 'content-type': 'application/json' }),
      ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
    },
    ...(raw === undefined ? {} : { payload: raw }),
  });
  return {
    status: response.statusCode,
    body: (response.body === '' ? undefined : JSON.parse(response.body)) as Record<string, unknown>,
    raw: response.body,
  };
}

function metaDestination(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'meta',
    enabled: true,
    clientEnabled: true,
    pixelId: '123456789012345',
    datasetId: '',
    apiVersion: 'v27.0',
    accessToken: TOKEN,
    testCode: 'TEST123',
    ...overrides,
  };
}

function ga4Destination(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'ga4',
    enabled: true,
    clientEnabled: true,
    measurementId: 'G-ABCDE12345',
    apiSecret: API_SECRET,
    ...overrides,
  };
}

function hubSettings(overrides: Record<string, unknown> = {}) {
  return {
    purchaseStage: 'confirmed',
    stageRoutes: {},
    webRoutes: [
      {
        name: 'Purchase',
        enabled: true,
        client: true,
        server: true,
        meta: true,
        ga4: true,
        tiktok: true,
      },
      {
        name: 'ViewContent',
        enabled: true,
        client: true,
        server: true,
        meta: true,
        ga4: true,
        tiktok: true,
      },
      {
        name: 'AddToCart',
        enabled: true,
        client: true,
        server: false,
        meta: true,
        ga4: true,
        tiktok: true,
      },
    ],
    proxy: {
      metaScriptPath: '/e1/s.js',
      metaCollectPath: '/e1/t',
      ga4ScriptPath: '/e2/s.js',
      ga4CollectPath: '/e2',
    },
    testMode: false,
    sendNameAndCity: false,
    chatToGa4: false,
    defaultCountryCode: '880',
    logRetentionDays: 30,
    ...overrides,
  };
}

interface EventRow extends Record<string, unknown> {
  id: string;
  kind: string;
  event_id: string;
  event_name: string;
  stage: string | null;
  value_poisha: string | null;
  action_source: string | null;
  payload_sealed: Buffer | null;
  user_masked: { email: string; phone: string };
  match_keys: Record<string, boolean>;
  custom_data: Record<string, unknown>;
  deliveries: { id: string; destination: string; status: string; last_error: string | null }[];
}

async function eventRows(orgId: string, where: ReturnType<typeof sql>): Promise<EventRow[]> {
  return withSystem(
    async (tx) => [
      ...(await tx.execute<EventRow>(sql`
        select e.id, e.kind, e.event_id, e.event_name, e.stage, e.value_poisha, e.action_source,
               e.payload_sealed, e.user_masked, e.match_keys, e.custom_data,
               coalesce((select json_agg(json_build_object('id', d.id, 'destination', d.destination,
                                 'status', d.status, 'last_error', d.last_error)
                                 order by d.destination)
                         from tracking.deliveries d
                         where d.org_id = e.org_id and d.event_row_id = e.id), '[]'::json) as deliveries
        from tracking.events e where e.org_id = ${orgId} and ${where}
        order by e.created_at
      `)),
    ],
    { orgId },
  );
}

function statusEvent(orgId: string, id: string, to: string): DeliveredEvent {
  return {
    id: randomUUID(),
    orgId,
    name: 'order.status_changed',
    payload: { id, orderNo: 'x', from: null, to, at: new Date().toISOString() },
    rooms: [],
    attempts: 1,
    occurredAt: new Date(),
    actorUserId: null,
  };
}

async function anOrder(
  channel: string,
  input: { readonly status?: string; readonly deliveredQty?: number } = {},
) {
  const order = await seedOrder(ORG_A, {
    status: input.status ?? 'confirmed',
    customerId,
    lines: [
      {
        skuId,
        skuCode,
        productName: 'Panjabi',
        qty: 2,
        unitPricePoisha: 125_000n,
        ...(input.deliveredQty === undefined ? {} : { deliveredQty: input.deliveredQty }),
      },
    ],
  });
  await withSystem(
    (tx) =>
      tx.execute(sql`update sales.orders set channel = ${channel}::sales.order_channel
                     where org_id = ${ORG_A} and id = ${order.id}`),
    { orgId: ORG_A },
  );
  return order;
}

async function deliverAll(orgId: string, rows: readonly EventRow[]): Promise<void> {
  for (const row of rows) {
    for (const delivery of row.deliveries) await deliveries.deliver(orgId, delivery.id);
  }
}

beforeAll(async () => {
  harness = await startHttpHarness('tracking');
  await applyOrderMigrations();
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: [
      ...TRACKING_QUEUE_DEFINITIONS,
      ...STOREFRONT_QUEUE_DEFINITIONS,
      ...MARKETPLACE_QUEUE_DEFINITIONS,
      ...NOTIFY_QUEUES,
    ],
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });
  const bound: unknown = harness.app.get(TRACKING_GATEWAY, { strict: false });
  if (!(bound instanceof FakeTrackingGateway))
    throw new Error('the suite expects the fake gateway');
  gateway = bound;
  events = harness.app.get(TrackingOrderEvents, { strict: false });
  deliveries = harness.app.get(TrackingDeliveries, { strict: false });
  setup = harness.app.get(TrackingSetupService, { strict: false });
  hub = harness.app.get<TrackingApi>(TRACKING_API, { strict: false });
  orders = harness.app.get<OrdersApi>(ORDERS_API, { strict: false });
  admin = await harness.asRole('org_admin', ORG_A);
  marketing = await harness.asRole('marketing', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  adminB = await harness.asRole('org_admin', ORG_B);
  key = await insertTestSiteKey(ORG_A);
  const seeded = await seedProductWithSkus(ORG_A, `tk${suffix}`, 1);
  skuId = seeded.skus[0]?.id ?? '';
  skuCode = seeded.skus[0]?.code ?? '';
  await withSystem(
    (tx) =>
      tx.execute(sql`update catalog.products set web_visible = true
                     where org_id = ${ORG_A} and id = ${seeded.productId}`),
    { orgId: ORG_A },
  );
  await seedStockLevel(ORG_A, {
    skuId,
    locationId: await warehouseId(ORG_A),
    qty: 50,
    unitCostPoisha: 60_000n,
  });
  customerId = await seedCustomer(ORG_A, { phoneE164: '+8801712345678', name: 'Rahim Uddin' });
  const found = await withSystem(
    async (tx) =>
      (
        await tx.execute<{ district_id: number; thana_id: number }>(sql`
          select a.district_id,
                 coalesce(a.thana_id, (select t.id from ref.thanas t
                                        where t.district_id = a.district_id order by t.id limit 1)) as thana_id
          from sales.delivery_zone_areas a
          join sales.delivery_zones z on z.org_id = a.org_id and z.id = a.zone_id
          where a.org_id = ${ORG_A} and z.is_active
          order by a.district_id limit 1
        `)
      )[0],
    { orgId: ORG_A },
  );
  area = { districtId: found?.district_id ?? 0, thanaId: found?.thana_id ?? 0 };
}, 300_000);

afterAll(async () => {
  await jobs?.stop();
  await harness.close();
});

describe('Settings → Tracking (checks 5, 6, 7)', () => {
  it('keeps secrets sealed and write-only, and leaves where they go to the org admin', async () => {
    const first = await marketing.client.request('GET', '/v1/tracking');
    expect(first.statusCode, first.body).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({
      settings: { purchaseStage: 'confirmed', importedFrom: 'none' },
      provider: 'fake',
      credentialsKey: true,
    });

    const byMarketing = await marketing.client.request('PUT', '/v1/tracking/destinations/meta', {
      body: metaDestination(),
    });
    expect(byMarketing.statusCode, byMarketing.body).toBe(403);
    expect(byMarketing.body).toContain('TRACKING_CREDENTIALS_FORBIDDEN');
    // Ids alone, or clearing the secret alone, are the org admin's too.
    for (const body of [
      metaDestination({ accessToken: undefined, pixelId: '999999999999' }),
      metaDestination({ accessToken: null }),
    ]) {
      const refused = await marketing.client.request('PUT', '/v1/tracking/destinations/meta', {
        body,
      });
      expect(refused.statusCode, refused.body).toBe(403);
    }
    const bySales = await sales.client.request('GET', '/v1/tracking');
    expect(bySales.statusCode).toBe(403);

    for (const body of [metaDestination(), ga4Destination()]) {
      const saved = await admin.client.request('PUT', `/v1/tracking/destinations/${body.kind}`, {
        body,
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.body).not.toContain(TOKEN);
      expect(saved.body).not.toContain(API_SECRET);
    }
    const viewed = await admin.client.request('GET', '/v1/tracking');
    expect(viewed.body).not.toContain(TOKEN);
    expect(viewed.body).not.toContain(API_SECRET);
    const view = JSON.parse(viewed.body) as {
      destinations: { kind: string; ready: boolean; secretFingerprint: string | null }[];
    };
    expect(view.destinations.find((d) => d.kind === 'meta')).toMatchObject({ ready: true });
    expect(view.destinations.find((d) => d.kind === 'meta')?.secretFingerprint).toMatch(
      /^[0-9a-f]{12}$/,
    );
    expect(view.destinations.find((d) => d.kind === 'tiktok')).toMatchObject({ ready: false });

    const stored = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ secret_sealed: Buffer }>(sql`
            select secret_sealed from tracking.destinations where org_id = ${ORG_A} and kind = 'meta'
          `)
        )[0],
      { orgId: ORG_A },
    );
    expect(Buffer.from(stored?.secret_sealed ?? []).toString('latin1')).not.toContain(TOKEN);

    // Marketing runs the switches: the same ids, no secret, the pixel switched.
    const switched = await marketing.client.request('PUT', '/v1/tracking/destinations/meta', {
      body: metaDestination({ accessToken: undefined, clientEnabled: true }),
    });
    expect(switched.statusCode, switched.body).toBe(200);
    const routed = await marketing.client.request('PUT', '/v1/tracking/settings', {
      body: hubSettings(),
    });
    expect(routed.statusCode, routed.body).toBe(200);
    // A platform M54b brings cannot be set up yet.
    const tiktok = await admin.client.request('PUT', '/v1/tracking/destinations/tiktok', {
      body: { kind: 'tiktok' },
    });
    expect(tiktok.statusCode).toBe(400);

    const audited = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ n: number }>(sql`
            select count(*)::int as n from audit.audit_log
            where org_id = ${ORG_A} and action like 'tracking.%'
          `)
        )[0]?.n,
      { orgId: ORG_A },
    );
    expect(audited).toBeGreaterThanOrEqual(4);
  });

  it('gives the website its config, with the browser’s Purchase off unless it is the placed stage (D-965)', async () => {
    const config = await signed('GET', '/storefront/v1/tracking/config');
    expect(config.status, config.raw).toBe(200);
    expect(config.raw).not.toContain(TOKEN);
    expect(config.raw).not.toContain(API_SECRET);
    expect(config.raw).not.toContain('TEST123');
    expect(config.body).toMatchObject({
      tracking: {
        meta: { pixelEnabled: true, pixelId: '123456789012345' },
        ga4: { clientEnabled: true, measurementId: 'G-ABCDE12345' },
        purchaseStage: 'confirmed',
        events: [
          { name: 'Purchase', enabled: true, client: false },
          { name: 'ViewContent', enabled: true, client: true },
          { name: 'AddToCart', enabled: true, client: true },
        ],
      },
    });
  });

  it('sends a test event with the destination’s test code and records the answer', async () => {
    gateway.clear();
    const tested = await marketing.client.request('POST', '/v1/tracking/destinations/meta/test');
    expect(tested.statusCode, tested.body).toBe(200);
    expect(JSON.parse(tested.body)).toMatchObject({ ok: true });
    expect(gateway.meta.at(-1)).toMatchObject({ testEventCode: 'TEST123', token: TOKEN });
    expect((gateway.meta.at(-1)?.event as { event_name: string }).event_name).toBe(
      'ErpConnectionTest',
    );
    const ga4 = await marketing.client.request('POST', '/v1/tracking/destinations/ga4/test');
    expect(JSON.parse(ga4.body)).toMatchObject({ ok: true });
    expect(gateway.ga4.at(-1)?.debug).toBe(true);
  });
});

describe('every channel’s order (check 1)', () => {
  it('makes exactly one Purchase at confirmation per platform, however often the outbox repeats it', async () => {
    gateway.clear();
    const channels = ['facebook', 'whatsapp', 'phone', 'website', 'marketplace'] as const;
    const placed = [];
    for (const channel of channels) placed.push({ channel, ...(await anOrder(channel)) });
    for (const order of placed) {
      await events.onStatusChanged(statusEvent(ORG_A, order.id, 'confirmed'));
      await events.onStatusChanged(statusEvent(ORG_A, order.id, 'confirmed'));
      // Packing and shipping make no event.
      await events.onStatusChanged(statusEvent(ORG_A, order.id, 'packed'));
    }
    for (const order of placed) {
      const rows = await eventRows(ORG_A, sql`e.order_id = ${order.id}`);
      expect(rows, order.channel).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'stage',
        stage: 'confirmed',
        event_name: 'Purchase',
        event_id: `purchase_${order.orderNo}`,
        value_poisha: '250000',
      });
      // No browser of theirs: GA4 is left out unless the brand asks (D-966).
      expect(rows[0]?.deliveries.map((d) => d.destination)).toEqual(['meta']);
      expect(rows[0]?.deliveries[0]?.status).toBe('queued');
    }
    const actionSources = await eventRows(
      ORG_A,
      sql`e.order_id in (${sql.join(
        placed.map((o) => sql`${o.id}::uuid`),
        sql`, `,
      )})`,
    );
    expect(actionSources.map((row) => row.action_source)).toEqual([
      'chat',
      'chat',
      'phone_call',
      'other',
      'other',
    ]);

    await deliverAll(ORG_A, actionSources);
    expect(gateway.meta).toHaveLength(5);
    const sentText = JSON.stringify(gateway.meta.map((send) => send.event));
    expect(sentText).not.toContain('8801712345678');
    expect(sentText).not.toContain('Rahim');
    const first = gateway.meta[0]?.event as {
      user_data: Record<string, string>;
      custom_data: Record<string, unknown>;
    };
    expect(first.user_data.ph).toBe(sha('8801712345678'));
    expect(first.custom_data).toMatchObject({ currency: 'BDT', value: 2500, num_items: 2 });
    // Sent: nothing personal kept.
    const after = await eventRows(ORG_A, sql`e.order_id = ${placed[0]?.id ?? ''}`);
    expect(after[0]?.payload_sealed).toBeNull();
    expect(after[0]?.deliveries[0]?.status).toBe('sent');
  });

  it('writes nothing for a brand that sends nowhere', async () => {
    for (const body of [
      metaDestination({ accessToken: undefined, enabled: false }),
      ga4Destination({ apiSecret: undefined, enabled: false }),
    ]) {
      await admin.client.request('PUT', `/v1/tracking/destinations/${body.kind}`, { body });
    }
    const order = await anOrder('facebook');
    await events.onStatusChanged(statusEvent(ORG_A, order.id, 'confirmed'));
    expect(await eventRows(ORG_A, sql`e.order_id = ${order.id}`)).toHaveLength(0);
    for (const body of [
      metaDestination({ accessToken: undefined }),
      ga4Destination({ apiSecret: undefined }),
    ]) {
      await admin.client.request('PUT', `/v1/tracking/destinations/${body.kind}`, { body });
    }
  });

  it('tracks a desk order confirmed through the state machine, from its own outbox rows', async () => {
    const context = {
      orgId: ORG_A,
      userId: 'usr_tracking_desk',
      isSuperAdmin: false,
      roles: ['org_admin'],
      branchIds: [],
      branchIdsByRole: {},
      requestId: randomUUID(),
    } as unknown as ActiveContext;
    const request = (): AuditableRequest => {
      const value = {} as AuditableRequest;
      attachScope(value, 'update', 'Order', { kind: 'all' });
      return value;
    };
    const desk = harness.app.get(OrdersService, { strict: false });
    const created = await desk.create(context, request(), {
      channel: 'whatsapp',
      customerId,
      locationId: await warehouseId(ORG_A),
      courierId: await ownRiderCourier(ORG_A),
      deliveryChargePoisha: '6000',
      lines: [{ skuId, qty: 1, unitPricePoisha: '150000' }],
    });
    await desk.confirm(context, request(), created.id);
    const outbox = await withSystem(
      async (tx) =>
        tx.execute<{ id: string; name: string; payload: unknown; occurred_at: string }>(sql`
          select id, name, payload, created_at as occurred_at from events.outbox
          where org_id = ${ORG_A} and payload->>'id' = ${created.id}
            and name in ('order.created', 'order.status_changed')
          order by created_at, id
        `),
      { orgId: ORG_A },
    );
    expect(outbox.map((row) => row.name)).toEqual(['order.created', 'order.status_changed']);
    for (const row of [...outbox, ...outbox]) {
      const event: DeliveredEvent = {
        id: row.id,
        orgId: ORG_A,
        name: row.name,
        payload: row.payload,
        rooms: [],
        attempts: 1,
        occurredAt: new Date(row.occurred_at),
        actorUserId: null,
      };
      if (row.name === 'order.created') await events.onOrderCreated(event);
      else await events.onStatusChanged(event);
    }
    const rows = await eventRows(ORG_A, sql`e.order_id = ${created.id}`);
    expect(rows.map((row) => [row.event_name, row.value_poisha, row.action_source])).toEqual([
      ['OrderPlaced', '150000', 'chat'],
      ['Purchase', '150000', 'chat'],
    ]);
  });

  it('sends the other stages as their own events where they are routed', async () => {
    const order = await anOrder('facebook', { status: 'delivered', deliveredQty: 2 });
    const created: DeliveredEvent = {
      ...statusEvent(ORG_A, order.id, 'pending'),
      name: 'order.created',
      payload: { id: order.id, createdAt: new Date().toISOString() },
    };
    await events.onOrderCreated(created);
    await events.onStatusChanged(statusEvent(ORG_A, order.id, 'delivered'));
    const rows = await eventRows(ORG_A, sql`e.order_id = ${order.id}`);
    expect(rows.map((row) => [row.event_name, row.event_id])).toEqual([
      ['OrderPlaced', `placed_${order.orderNo}`],
      ['OrderDelivered', `delivered_${order.orderNo}`],
    ]);
    // Switched off for Meta: the next delivery of a stage goes nowhere.
    await marketing.client.request('PUT', '/v1/tracking/settings', {
      body: hubSettings({ stageRoutes: { cancelled: { meta: false } } }),
    });
    const other = await anOrder('facebook', { status: 'cancelled' });
    await events.onStatusChanged(statusEvent(ORG_A, other.id, 'cancelled'));
    expect(await eventRows(ORG_A, sql`e.order_id = ${other.id}`)).toHaveLength(0);
    await marketing.client.request('PUT', '/v1/tracking/settings', { body: hubSettings() });
  });
});

describe('the website (checks 2 and 3)', () => {
  let orderId = '';
  let orderNo = '';

  it('keeps the checkout’s signals for the Purchase at confirmation and its campaign on the order', async () => {
    gateway.clear();
    const current = await admin.client.request('GET', '/v1/storefront/settings');
    const settings = JSON.parse(current.body) as { siteInfo: Record<string, unknown> };
    await admin.client.request('PATCH', '/v1/storefront/settings', {
      body: {
        siteInfo: { ...settings.siteInfo, siteUrl: 'https://shop.example' },
        payments: { cod: true, sslcommerz: false },
      },
    });
    const quoted = await signed('POST', '/storefront/v1/cart/quote', {
      lines: [{ skuId, qty: 1 }],
      address: area,
    });
    const total = (quoted.body.quote as { total: { poisha: string } }).total.poisha;
    const placed = await signed(
      'POST',
      '/storefront/v1/checkout',
      {
        lines: [{ skuId, qty: 1 }],
        contact: { name: 'Rahima Akter', phone: '01712340001', email: 'rahima@example.com' },
        address: { ...area, addressLine: 'House 7, Road 3' },
        paymentMethod: 'cod',
        expected: { totalPoisha: total },
        tracking: {
          fbp: 'fb.1.9.9',
          fbclid: 'IwAR0hub',
          eventSourceUrl: 'https://shop.example/checkout',
          gaClientId: '333.444',
          utmSource: 'facebook',
          utmCampaign: 'eid-2026',
          campaignLinkCode: '48213',
        },
        client: { ip: '203.0.113.10', userAgent: 'Mozilla/5.0' },
      },
      randomUUID(),
    );
    expect(placed.status, placed.raw).toBe(201);
    orderNo = (placed.body.order as { orderNo: string }).orderNo;
    const found = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ id: string; source: Record<string, string> }>(sql`
            select id, source from sales.orders where org_id = ${ORG_A} and order_no = ${orderNo}
          `)
        )[0],
      { orgId: ORG_A },
    );
    orderId = found?.id ?? '';
    expect(found?.source).toEqual({
      utmSource: 'facebook',
      utmCampaign: 'eid-2026',
      campaignLinkCode: '48213',
    });
    // The marketing dashboard reads it: once confirmed, M18's facts carry its `utmCampaign`,
    // which attribution maps to a campaign (§11, rule 3).
    await withSystem(
      (tx) =>
        tx.execute(sql`update sales.orders set status = 'confirmed', confirmed_at = now()
                       where org_id = ${ORG_A} and id = ${orderId}`),
      { orgId: ORG_A },
    );
    const today = new Date().toISOString().slice(0, 10);
    const facts = await withSystem(
      (tx) =>
        orders.marketingFacts(tx, ORG_A, {
          from: '2026-01-01',
          to: today < '2026-12-31' ? '2026-12-31' : today,
        }),
      { orgId: ORG_A },
    );
    expect(facts.find((fact) => fact.orderId === orderId)?.source).toMatchObject({
      utmCampaign: 'eid-2026',
    });

    // Sealed: the browser ids are not readable at rest.
    const signals = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ signals_sealed: Buffer; present: Record<string, boolean> }>(sql`
            select signals_sealed, present from tracking.order_signals
            where org_id = ${ORG_A} and order_id = ${orderId}
          `)
        )[0],
      { orgId: ORG_A },
    );
    expect(Buffer.from(signals?.signals_sealed ?? []).toString('latin1')).not.toContain('IwAR0hub');
    expect(signals?.present).toMatchObject({ fbp: true, fbclid: true, gaClientId: true, ip: true });

    // Placed: a custom event. Confirmed: the Purchase, with the checkout's signals.
    await events.onStatusChanged(statusEvent(ORG_A, orderId, 'confirmed'));
    const rows = await eventRows(ORG_A, sql`e.order_id = ${orderId} and e.stage = 'confirmed'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action_source).toBe('website');
    expect(rows[0]?.deliveries.map((d) => d.destination)).toEqual(['ga4', 'meta']);
    await deliverAll(ORG_A, rows);
    const meta = gateway.meta.at(-1)?.event as {
      event_id: string;
      event_name: string;
      event_source_url: string;
      user_data: Record<string, string>;
    };
    expect(meta).toMatchObject({
      event_id: `purchase_${orderNo}`,
      event_name: 'Purchase',
      event_source_url: 'https://shop.example/checkout',
    });
    expect(meta.user_data.fbp).toBe('fb.1.9.9');
    expect(meta.user_data.fbc).toMatch(/^fb\.1\.\d+\.IwAR0hub$/);
    expect(meta.user_data.client_ip_address).toBe('203.0.113.10');
    expect(meta.user_data.em).toBe(sha('rahima@example.com'));
    expect(meta.user_data.client_user_agent).toBe('Mozilla/5.0');
    // Exactly these identifiers: hashes, Meta's browser ids, the address and the browser.
    expect(Object.keys(meta.user_data).sort()).toEqual([
      'client_ip_address',
      'client_user_agent',
      'country',
      'em',
      'external_id',
      'fbc',
      'fbp',
      'ph',
    ]);
    expect((meta as unknown as { custom_data: unknown }).custom_data).toEqual({
      currency: 'BDT',
      value: 1500,
      order_id: orderNo,
      content_type: 'product',
      content_ids: [skuCode],
      contents: [
        { id: skuCode, quantity: 1, item_price: 1500, name: expect.any(String) as string },
      ],
      num_items: 1,
    });
    const ga4Text = JSON.stringify(gateway.ga4.at(-1)?.payload);
    for (const plain of ['rahima', 'Rahima', '01712340001', '8801712340001', 'example.com']) {
      expect(ga4Text.includes(plain), plain).toBe(false);
    }
    expect(gateway.ga4.at(-1)?.payload).toMatchObject({
      client_id: '333.444',
      events: [{ name: 'purchase', params: { transaction_id: orderNo, currency: 'BDT' } }],
    });
  });

  it('refunds a cancelled sent purchase to GA4 once, and nothing for one never sent', async () => {
    gateway.clear();
    await events.onStatusChanged(statusEvent(ORG_A, orderId, 'cancelled'));
    await events.onStatusChanged(statusEvent(ORG_A, orderId, 'cancelled'));
    const refunds = await eventRows(ORG_A, sql`e.order_id = ${orderId} and e.kind = 'refund'`);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.deliveries.map((d) => d.destination)).toEqual(['ga4']);
    const purchase = await eventRows(
      ORG_A,
      sql`e.order_id = ${orderId} and e.event_name = 'Purchase'`,
    );
    expect(refunds[0]?.value_poisha).toBe(purchase[0]?.value_poisha);
    await deliverAll(ORG_A, refunds);
    expect(gateway.ga4.at(-1)?.payload).toMatchObject({
      events: [{ name: 'refund', params: { transaction_id: orderNo } }],
    });
    // Meta heard the cancel as its own event, and no refund.
    const cancel = await eventRows(
      ORG_A,
      sql`e.order_id = ${orderId} and e.kind = 'stage' and e.stage = 'cancelled'`,
    );
    expect(cancel[0]?.event_name).toBe('OrderCancelled');
    expect(cancel[0]?.deliveries.map((d) => d.destination)).toContain('meta');

    const unsent = await anOrder('facebook', { status: 'cancelled' });
    await events.onStatusChanged(statusEvent(ORG_A, unsent.id, 'cancelled'));
    expect(
      await eventRows(ORG_A, sql`e.order_id = ${unsent.id} and e.kind = 'refund'`),
    ).toHaveLength(0);
  });

  it('refunds a partial delivery’s shortfall, then nothing more when the rest comes back', async () => {
    const order = await anOrder('website', { status: 'confirmed' });
    await withSystem(
      (tx) =>
        hub.recordOrderSignals(
          tx,
          ORG_A,
          order.id,
          { gaClientId: '555.666' },
          { awaitingPayment: false },
        ),
      { orgId: ORG_A },
    );
    await events.onStatusChanged(statusEvent(ORG_A, order.id, 'confirmed'));
    await withSystem(
      (tx) =>
        tx.execute(sql`update sales.order_lines set delivered_qty = 1
                       where org_id = ${ORG_A} and order_id = ${order.id}`),
      { orgId: ORG_A },
    );
    await events.onStatusChanged(statusEvent(ORG_A, order.id, 'partially_delivered'));
    await events.onStatusChanged(statusEvent(ORG_A, order.id, 'returned'));
    const refunds = await eventRows(ORG_A, sql`e.order_id = ${order.id} and e.kind = 'refund'`);
    expect(refunds.map((row) => [row.event_id, row.value_poisha])).toEqual([
      [`refund_delivered_${order.orderNo}`, '125000'],
    ]);
    const stages = await eventRows(ORG_A, sql`e.order_id = ${order.id} and e.kind = 'stage'`);
    expect(stages.map((row) => [row.event_name, row.value_poisha])).toEqual([
      ['Purchase', '250000'],
      ['OrderDelivered', '125000'],
      ['OrderReturned', '125000'],
    ]);
  });

  it('skips a browser Purchase, and hashes and delivers the browser’s other events', async () => {
    gateway.clear();
    const eventId = `vc_${suffix}`;
    const accepted = await signed('POST', '/storefront/v1/events', {
      events: [
        {
          eventName: 'ViewContent',
          eventId,
          eventSourceUrl: 'https://shop.example/shop/shirt',
          userData: { email: 'Rahim@Example.com', phone: '01712345678', fbp: 'fb.1.1.2' },
          customData: { value: 1500, currency: 'BDT', content_ids: [skuId] },
          ga4: { clientId: '111.222' },
        },
        { eventName: 'AddToCart', eventId: `atc_${suffix}` },
        { eventName: 'Purchase', eventId: `purchase_browser_${suffix}` },
      ],
      client: { ip: '203.0.113.9', userAgent: 'Mozilla/5.0' },
    });
    expect(accepted.body).toEqual({
      ok: true,
      results: [
        { eventId, status: 'queued' },
        { eventId: `atc_${suffix}`, status: 'skipped' },
        { eventId: `purchase_browser_${suffix}`, status: 'skipped' },
      ],
    });
    const rows = await eventRows(ORG_A, sql`e.event_id = ${eventId}`);
    expect(rows[0]).toMatchObject({ kind: 'browser' });
    expect(rows[0]?.user_masked).toEqual({ email: 'R***@Example.com', phone: '017******78' });
    const sealedText = Buffer.from(rows[0]?.payload_sealed ?? []).toString('latin1');
    expect(sealedText).not.toContain('Rahim');
    expect(sealedText).not.toContain('01712345678');
    await deliverAll(ORG_A, rows);
    const userData = (gateway.meta.at(-1)?.event as { user_data: Record<string, string> })
      .user_data;
    expect(userData.em).toBe(sha('rahim@example.com'));
    expect(userData.ph).toBe(sha('8801712345678'));
    expect(gateway.ga4.at(-1)?.payload).toMatchObject({ client_id: '111.222' });
  });
});

describe('a purchase paid online (W2)', () => {
  it('waits for the payment when Purchase is the placed stage, then goes; a cancel drops it', async () => {
    await marketing.client.request('PUT', '/v1/tracking/settings', {
      body: hubSettings({ purchaseStage: 'placed' }),
    });
    const paid = await anOrder('website', { status: 'pending' });
    const unpaid = await anOrder('website', { status: 'pending' });
    for (const order of [paid, unpaid]) {
      await withSystem(
        (tx) =>
          hub.recordOrderSignals(
            tx,
            ORG_A,
            order.id,
            { gaClientId: '777.888' },
            { awaitingPayment: true },
          ),
        { orgId: ORG_A },
      );
      await events.onOrderCreated({
        ...statusEvent(ORG_A, order.id, 'pending'),
        name: 'order.created',
        payload: { id: order.id, createdAt: new Date().toISOString() },
      });
      const [row] = await eventRows(ORG_A, sql`e.order_id = ${order.id}`);
      expect(row?.event_name).toBe('Purchase');
      expect(row?.deliveries.map((d) => d.status)).toEqual(['waiting', 'waiting']);
    }
    await withSystem((tx) => hub.paymentBooked(tx, ORG_A, paid.id), { orgId: ORG_A });
    const [released] = await eventRows(ORG_A, sql`e.order_id = ${paid.id}`);
    expect(released?.deliveries.map((d) => d.status)).toEqual(['queued', 'queued']);
    await events.onStatusChanged(statusEvent(ORG_A, unpaid.id, 'cancelled'));
    const [dropped] = await eventRows(
      ORG_A,
      sql`e.order_id = ${unpaid.id} and e.event_name = 'Purchase'`,
    );
    expect(dropped?.deliveries.map((d) => d.status)).toEqual(['skipped', 'skipped']);
    await marketing.client.request('PUT', '/v1/tracking/settings', { body: hubSettings() });
  });
});

describe('deliveries (checks 4 and 7)', () => {
  it('fails a refused send on its own, retries it on request, and refuses to retry a sent one', async () => {
    gateway.clear();
    const order = await anOrder('phone');
    await events.onStatusChanged(statusEvent(ORG_A, order.id, 'confirmed'));
    const [row] = await eventRows(ORG_A, sql`e.order_id = ${order.id}`);
    const deliveryId = row?.deliveries[0]?.id ?? '';
    gateway.failNextMeta = 'Invalid parameter';
    await deliveries.deliver(ORG_A, deliveryId);
    const [failed] = await eventRows(ORG_A, sql`e.order_id = ${order.id}`);
    expect(failed?.deliveries[0]).toMatchObject({ status: 'failed' });
    expect(failed?.payload_sealed).not.toBeNull();

    const bySales = await sales.client.request(
      'POST',
      `/v1/tracking/deliveries/${deliveryId}/retry`,
    );
    expect(bySales.statusCode).toBe(403);
    const retried = await marketing.client.request(
      'POST',
      `/v1/tracking/deliveries/${deliveryId}/retry`,
    );
    expect(retried.statusCode, retried.body).toBe(200);
    await deliveries.deliver(ORG_A, deliveryId);
    const [sent] = await eventRows(ORG_A, sql`e.order_id = ${order.id}`);
    expect(sent?.deliveries[0]).toMatchObject({ status: 'sent' });
    const again = await marketing.client.request(
      'POST',
      `/v1/tracking/deliveries/${deliveryId}/retry`,
    );
    expect(again.statusCode).toBe(409);
  });

  it('leaves an answer a retry could change queued for pg-boss to try again, then sends it', async () => {
    const order = await anOrder('phone');
    await events.onStatusChanged(statusEvent(ORG_A, order.id, 'confirmed'));
    const [row] = await eventRows(ORG_A, sql`e.order_id = ${order.id}`);
    const deliveryId = row?.deliveries[0]?.id ?? '';
    gateway.failNextMeta = 'Meta did not answer in time.';
    gateway.failNextMetaRetryable = true;
    await expect(deliveries.deliver(ORG_A, deliveryId)).rejects.toBeInstanceOf(TrackingRetryLater);
    const [waiting] = await eventRows(ORG_A, sql`e.order_id = ${order.id}`);
    expect(waiting?.deliveries[0]).toMatchObject({ status: 'queued' });
    await deliveries.deliver(ORG_A, deliveryId);
    const [sent] = await eventRows(ORG_A, sql`e.order_id = ${order.id}`);
    expect(sent?.deliveries[0]).toMatchObject({ status: 'sent' });
  });

  it('skips an event past the platform’s limit with the reason', async () => {
    const order = await anOrder('phone');
    await events.onStatusChanged(statusEvent(ORG_A, order.id, 'confirmed'));
    const [row] = await eventRows(ORG_A, sql`e.order_id = ${order.id}`);
    const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    await deliveries.deliver(ORG_A, row?.deliveries[0]?.id ?? '', later);
    const [skipped] = await eventRows(ORG_A, sql`e.order_id = ${order.id}`);
    expect(skipped?.deliveries[0]).toMatchObject({ status: 'skipped' });
    expect(skipped?.deliveries[0]?.last_error).toContain('Too old');
  });

  it('shows the log, the week and an order’s events to marketing, and none of it to another brand', async () => {
    const log = await marketing.client.request('GET', '/v1/tracking/events?limit=5');
    expect(log.statusCode, log.body).toBe(200);
    const page = JSON.parse(log.body) as {
      items: { deliveries: unknown[] }[];
      nextCursor: string | null;
    };
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).not.toBeNull();
    expect(log.body).not.toContain('8801712345678');
    const week = JSON.parse(
      (await marketing.client.request('GET', '/v1/tracking/summary')).body,
    ) as {
      destinations: { destination: string; sent: number }[];
    };
    expect(week.destinations.find((d) => d.destination === 'meta')?.sent).toBeGreaterThan(0);

    const other = await adminB.client.request('GET', '/v1/tracking/events');
    expect(JSON.parse(other.body)).toMatchObject({ items: [] });
    const rls = await withSystem(
      async (tx) =>
        (await tx.execute<{ n: number }>(sql`select count(*)::int as n from tracking.events`))[0]
          ?.n,
      { orgId: ORG_B },
    );
    expect(rls).toBe(0);
  });
});

describe('the one-time import (check 6)', () => {
  it('moves Website → Tracking’s settings and secrets into the hub, once, without re-entry', async () => {
    const tokenSealed = seal(TOKEN, {
      orgId: ORG_B,
      row: 'tracking_settings',
      field: 'meta_token',
    });
    const secretSealed = seal(API_SECRET, {
      orgId: ORG_B,
      row: 'tracking_settings',
      field: 'ga4_secret',
    });
    await withSystem(
      (tx) =>
        upsertTrackingSettings(tx, {
          orgId: ORG_B,
          metaPixelEnabled: true,
          metaCapiEnabled: true,
          metaPixelId: '998877665544',
          metaDatasetId: '',
          metaApiVersion: 'v21.0',
          metaTestEventCode: 'OLD1',
          defaultCountryCode: '880',
          ga4ClientEnabled: true,
          ga4MpEnabled: true,
          ga4MeasurementId: 'G-OLDGA4ID',
          proxy: { metaScriptPath: '/x1/s.js' },
          testMode: false,
          events: [
            { name: 'PageView', enabled: true, client: true, server: false, meta: true, ga4: true },
          ],
          logRetentionDays: 14,
          metaToken: { sealed: tokenSealed.ciphertext, fingerprint: tokenSealed.fingerprint },
          ga4Secret: { sealed: secretSealed.ciphertext, fingerprint: secretSealed.fingerprint },
          keyId: tokenSealed.keyId,
          updatedBy: 'usr_old',
        }),
      { orgId: ORG_B },
    );
    // A marketing link too, which loses to Website → Tracking's pixel.
    const marketingToken = sealToken('EAAB-marketing-only-token-000000001', ORG_B, {
      key: process.env.MARKETING_CREDENTIALS_KEY,
      keyId: 'v1',
    });
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into marketing.meta_connections
            (org_id, pixel_id, token, token_key_id, token_fingerprint, capi_enabled,
             send_name_and_city, updated_by)
          values (${ORG_B}, '111122223333', ${marketingToken.ciphertext}, 'v1',
                  ${marketingToken.fingerprint}, true, true, 'usr_old')
          on conflict do nothing
        `),
      { orgId: ORG_B },
    );

    expect(await setup.importIfNeeded(ORG_B)).toBe(true);
    expect(await setup.importIfNeeded(ORG_B)).toBe(false);
    const view = JSON.parse((await adminB.client.request('GET', '/v1/tracking')).body) as {
      settings: {
        importedFrom: string;
        logRetentionDays: number;
        sendNameAndCity: boolean;
        proxy: Record<string, string>;
      };
      destinations: {
        kind: string;
        publicIds: Record<string, string>;
        ready: boolean;
        testCode: string;
        apiVersion: string;
      }[];
    };
    expect(view.settings).toMatchObject({
      importedFrom: 'storefront_and_marketing',
      logRetentionDays: 14,
      sendNameAndCity: true,
      proxy: { metaScriptPath: '/x1/s.js', metaCollectPath: '/e1/t' },
    });
    expect(view.destinations.find((d) => d.kind === 'meta')).toMatchObject({
      publicIds: { pixelId: '998877665544', datasetId: '' },
      ready: true,
      testCode: 'OLD1',
      apiVersion: 'v27.0',
    });
    expect(view.destinations.find((d) => d.kind === 'ga4')).toMatchObject({
      publicIds: { measurementId: 'G-OLDGA4ID' },
      ready: true,
    });
    // Re-sealed under the hub's own binding.
    const stored = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ secret_sealed: Buffer }>(sql`
            select secret_sealed from tracking.destinations where org_id = ${ORG_B} and kind = 'meta'
          `)
        )[0],
      { orgId: ORG_B },
    );
    expect(open(Buffer.from(stored?.secret_sealed ?? []), bindings.secret(ORG_B, 'meta'))).toBe(
      TOKEN,
    );
  });

  it('imports a pixel marketing set in Marketing → Meta switched off, for an org admin (W3)', async () => {
    const orgC = SEED_ORG_IDS.orvo ?? '';
    const token = sealToken('EAAB-marketing-only-token-000000002', orgC, {
      key: process.env.MARKETING_CREDENTIALS_KEY,
      keyId: 'v1',
    });
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into marketing.meta_connections
            (org_id, pixel_id, token, token_key_id, token_fingerprint, capi_enabled, updated_by)
          values (${orgC}, '444455556666', ${token.ciphertext}, 'v1', ${token.fingerprint}, true,
                  'usr_old')
          on conflict do nothing
        `),
      { orgId: orgC },
    );
    expect(await setup.importIfNeeded(orgC)).toBe(true);
    const row = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ enabled: boolean; public_ids: Record<string, string> }>(sql`
            select enabled, public_ids from tracking.destinations
            where org_id = ${orgC} and kind = 'meta'
          `)
        )[0],
      { orgId: orgC },
    );
    expect(row).toMatchObject({ enabled: false, public_ids: { pixelId: '444455556666' } });
  });
});

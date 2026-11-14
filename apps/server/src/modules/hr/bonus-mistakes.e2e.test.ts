import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { seedProductWithSkus } from '../inventory/inventory.testing.js';
import { seedCustomer, seedOrder } from '../orders/orders.testing.js';
import { seedPendingOrder } from '../staff-activity/staff-activity.testing.js';
import { seedEmployee, seedStructure } from './hr.testing.js';
import { TargetsService } from './targets.service.js';

/**
 * M57 check 6 on real PostgreSQL (D-1001): a bonus rule's `mistakes` block in a payroll run.
 *
 * Asha confirms 12 orders in August 2026 against a target of 10 (120%): the rule pays ৳2,000 at
 * 100% and ৳50 for each order above target from 120%, ৳2,100. She also let three promised
 * call-backs pass that month; each confirmed one takes ৳500 off, up to ৳1,000. Only an org
 * admin's confirmed mistakes count, only with the brand's switch on, never below zero, and what
 * was counted is fixed with the award.
 */

const MONTH = '2026-08';
const AUGUST = { from: '2026-08-01', to: '2026-08-31' };

let harness: HttpHarness;
let admin: RoleClient;
let hr: RoleClient;
let secondHr: RoleClient;
let asha: RoleClient;
let employee = '';
let runId = '';
const callBacks: string[] = [];

function body<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

interface Award {
  employeeId: string;
  amountPoisha: string;
  mistakesApplied: boolean;
  mistakeDeductionPoisha: string;
  /** How many; which ones stay with the award in the database (accounts reads payroll too). */
  mistakesCounted: number;
}

/** The mistakes kept with the run's award of this amount, as the database holds them. */
async function frozenKeys(amountPoisha: string): Promise<string[]> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ keys: string[] }>(sql`
        select mistake_keys as keys from hr.bonus_awards
        where org_id = ${ORG_A} and run_id = ${runId} and amount_poisha = ${amountPoisha}::bigint
      `);
      return rows[0]?.keys ?? [];
    },
    { orgId: ORG_A },
  );
}

async function setSwitch(on: boolean): Promise<void> {
  const response = await admin.client.request('PUT', '/v1/staff-activity/settings', {
    body: {
      callBackGraceMinutes: 30,
      firstReplyMinutes: 15,
      unansweredMinutes: 60,
      wrapUpMinutes: 10,
      workdayStartMinute: 540,
      workdayEndMinute: 1320,
      requireVerificationCall: false,
      showColleagueNames: true,
      mistakesReduceBonuses: on,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function review(key: string, status: 'confirmed' | 'dismissed'): Promise<void> {
  const response = await admin.client.request('PUT', '/v1/staff-activity/mistakes/review', {
    body: { key, ...AUGUST, status },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function apply(): Promise<{
  items: Award[];
  totalPoisha: string;
  zeroedByMistakes: { employeeId: string; mistakes: number }[];
}> {
  const response = await hr.client.request('POST', `/v1/hr/payroll/runs/${runId}/bonuses`);
  expect(response.statusCode, response.body).toBe(201);
  return body(response);
}

async function approveRule(name: string, definition: unknown): Promise<void> {
  const created = await hr.client.request('POST', '/v1/hr/bonus-rules', {
    body: { name, definition },
  });
  expect(created.statusCode, created.body).toBe(201);
  const versionId = body<{ versions: { id: string }[] }>(created).versions[0]?.id ?? '';
  const submitted = await hr.client.request(
    'POST',
    `/v1/hr/bonus-rules/versions/${versionId}/submit`,
    { body: {} },
  );
  expect(submitted.statusCode, submitted.body).toBe(201);
  const approvalId =
    body<{ versions: { id: string; approvalId: string | null }[] }>(submitted).versions.find(
      (v) => v.id === versionId,
    )?.approvalId ?? '';
  const decided = await secondHr.client.request('POST', `/v1/approvals/${approvalId}/decide`, {
    body: { decision: 'approved' },
  });
  expect(decided.statusCode, decided.body).toBe(201);
}

beforeAll(async () => {
  process.env.LOG_LEVEL = 'fatal';
  harness = await startHttpHarness('bonus-mistakes');
  harness.app.get(TargetsService).now = () => new Date('2026-08-02T06:00:00Z');
  admin = await harness.asRole('org_admin', ORG_A);
  hr = await harness.asRole('hr', ORG_A);
  secondHr = await harness.asRole('hr', ORG_A);
  asha = await harness.asRole('sales', ORG_A);

  employee = (
    await seedEmployee(ORG_A, {
      code: 'MIST-A',
      fullName: 'Agent Asha',
      joinDate: '2026-01-01',
      userId: asha.userId,
    })
  ).id;
  await seedStructure(ORG_A, {
    employeeId: employee,
    effectiveFrom: '2026-01-01',
    basicPoisha: 2_000_000n,
  });

  const customerId = await seedCustomer(ORG_A, {
    phoneE164: '+8801700000888',
    name: 'Bonus Buyer',
  });
  const { skus } = await seedProductWithSkus(ORG_A, 'bonusmistakes', 1);
  const sku = skus[0];
  if (sku === undefined) throw new Error('no SKU');
  for (let index = 0; index < 12; index += 1) {
    const { id } = await seedOrder(ORG_A, {
      status: 'confirmed',
      customerId,
      assignedTo: asha.userId,
      lines: [
        {
          skuId: sku.id,
          skuCode: sku.code,
          productName: 'Kurta',
          qty: 1,
          unitPricePoisha: 100_000n,
        },
      ],
    });
    await withSystem(
      (tx) =>
        tx.execute(sql`
          update sales.orders set confirmed_by = ${asha.userId},
                 confirmed_at = '2026-08-12T10:00:00+06:00'::timestamptz
          where org_id = ${ORG_A} and id = ${id}
        `),
      { orgId: ORG_A },
    );
  }

  // Three call-backs promised for the afternoon of 10 August that nobody made.
  const order = await seedPendingOrder(ORG_A, asha.userId);
  for (let index = 0; index < 3; index += 1) {
    const id = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          insert into sales.call_attempts (org_id, order_id, outcome, call_back_at, called_by, called_at)
          values (${ORG_A}, ${order.id}, 'call_back',
                  ${`2026-08-10T1${String(4 + index)}:00:00+06:00`}::timestamptz, ${asha.userId},
                  '2026-08-10T10:00:00+06:00'::timestamptz)
          returning id
        `);
        return rows[0]?.id ?? '';
      },
      { orgId: ORG_A },
    );
    callBacks.push(`call_back_missed:${id}`);
  }

  const target = await hr.client.request('POST', '/v1/hr/targets', {
    body: {
      scope: 'employee',
      month: MONTH,
      metric: 'confirmed_orders',
      employeeId: employee,
      targetValue: '10',
    },
  });
  expect(target.statusCode, target.body).toBe(201);

  await approveRule('Desk confirmations, less mistakes', {
    metric: 'confirmed_orders',
    tiers: [
      { gte_pct: 100, amount_poisha: 200000 },
      { gte_pct: 120, per_unit_above_target_poisha: 5000 },
    ],
    mistakes: { per_mistake_poisha: 50000, kinds: ['call_back_missed'], max_poisha: 100000 },
  });

  const run = await hr.client.request('POST', '/v1/hr/payroll/runs', { body: { month: MONTH } });
  expect(run.statusCode, run.body).toBe(201);
  runId = body<{ id: string }>(run).id;
}, 600_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('check 6: confirmed mistakes in a payroll run', () => {
  it('with the switch off (the default), pays the full bonus however many mistakes', async () => {
    const applied = await apply();
    expect(applied.items).toEqual([
      expect.objectContaining({
        employeeId: employee,
        amountPoisha: '210000',
        mistakesApplied: false,
        mistakeDeductionPoisha: '0',
        mistakesCounted: 0,
      }),
    ]);
  });

  it('counts only an org admin’s confirmed mistakes, and pays exactly that much less', async () => {
    await setSwitch(true);
    // Unreviewed: nothing comes off yet.
    expect((await apply()).items[0]?.amountPoisha).toBe('210000');

    // One confirmed: exactly ৳500 off, under the cap.
    await review(callBacks[0] ?? '', 'confirmed');
    expect((await apply()).items[0]).toMatchObject({
      amountPoisha: '160000',
      mistakeDeductionPoisha: '50000',
    });
    await review(callBacks[1] ?? '', 'confirmed');
    await review(callBacks[2] ?? '', 'dismissed');
    const applied = await apply();
    const award = applied.items[0];
    expect(award).toMatchObject({
      amountPoisha: '110000',
      mistakesApplied: true,
      mistakeDeductionPoisha: '100000',
    });
    expect(award?.mistakesCounted).toBe(2);
    expect([...(await frozenKeys('110000'))].sort()).toEqual([callBacks[0], callBacks[1]].sort());

    // The payslip carries the reduced bonus.
    const preview = body<{ payslips: { employeeId: string; bonusPoisha: string }[] }>(
      await hr.client.request('GET', `/v1/hr/payroll/runs/${runId}/preview`),
    );
    expect(preview.payslips.find((line) => line.employeeId === employee)?.bonusPoisha).toBe(
      '110000',
    );
  });

  it('a review changed after the bonus was applied leaves the award as it was', async () => {
    await review(callBacks[0] ?? '', 'dismissed');
    const awards = body<{ items: Award[] }>(
      await hr.client.request('GET', `/v1/hr/payroll/runs/${runId}/bonuses`),
    ).items;
    expect(awards[0]).toMatchObject({ amountPoisha: '110000', mistakeDeductionPoisha: '100000' });
    // Applying again (the run is still a draft) is what reads the reviews afresh.
    expect((await apply()).items[0]).toMatchObject({
      amountPoisha: '160000',
      mistakeDeductionPoisha: '50000',
    });
  });

  it('caps the deduction at the rule’s max, and never takes the bonus below zero', async () => {
    for (const key of callBacks) await review(key, 'confirmed');
    // Three confirmed × ৳500 = ৳1,500, capped at ৳1,000.
    expect((await apply()).items[0]).toMatchObject({
      amountPoisha: '110000',
      mistakeDeductionPoisha: '100000',
    });

    // A stricter rule: ৳1,000 a mistake, no cap. ৳3,000 off ৳2,100 leaves nothing, not less.
    await approveRule('Strict on call-backs', {
      metric: 'confirmed_orders',
      tiers: [{ gte_pct: 100, amount_poisha: 210000 }],
      mistakes: { per_mistake_poisha: 100000, kinds: ['call_back_missed'] },
    });
    const applied = await apply();
    const strict = applied.items.filter((item) => item.amountPoisha !== '110000');
    expect(strict).toEqual([]);
    expect(applied.zeroedByMistakes).toEqual([
      expect.objectContaining({ employeeId: employee, mistakes: 3 }),
    ]);
    expect(applied.totalPoisha).toBe('110000');
  });

  it('with the switch turned off again, the same run pays the full bonuses', async () => {
    await setSwitch(false);
    const applied = await apply();
    expect(applied.items.map((item) => item.amountPoisha).sort()).toEqual(['210000', '210000']);
    expect(applied.items.every((item) => !item.mistakesApplied)).toBe(true);
    expect(applied.zeroedByMistakes).toEqual([]);
  });

  it('once the run is approved, a review changed afterwards moves nothing', async () => {
    await setSwitch(true);
    const applied = await apply();
    const before = applied.items.find((item) => item.amountPoisha !== '210000');
    expect(before).toMatchObject({ amountPoisha: '110000', mistakeDeductionPoisha: '100000' });
    expect(before?.mistakesCounted).toBe(3);
    const keysBefore = await frozenKeys('110000');
    expect(keysBefore).toHaveLength(3);

    const submitted = await hr.client.request('POST', `/v1/hr/payroll/runs/${runId}/submit`, {
      body: { reason: 'August 2026 payroll' },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const approvalId = body<{ approvalId: string }>(submitted).approvalId;
    const decided = await secondHr.client.request('POST', `/v1/approvals/${approvalId}/decide`, {
      body: { decision: 'approved' },
    });
    expect(decided.statusCode, decided.body).toBe(201);

    // An org admin changes their mind about two of the three mistakes after approval.
    await review(callBacks[0] ?? '', 'dismissed');
    await review(callBacks[1] ?? '', 'dismissed');

    const awards = body<{ items: Award[] }>(
      await hr.client.request('GET', `/v1/hr/payroll/runs/${runId}/bonuses`),
    ).items;
    const after = awards.find((item) => item.mistakesApplied && item.amountPoisha !== '0');
    expect(after).toMatchObject({ amountPoisha: '110000', mistakeDeductionPoisha: '100000' });
    expect(after?.mistakesCounted).toBe(3);
    expect([...(await frozenKeys('110000'))].sort()).toEqual([...keysBefore].sort());

    // And the run can no longer have its bonuses applied again.
    const again = await hr.client.request('POST', `/v1/hr/payroll/runs/${runId}/bonuses`);
    expect(again.statusCode).toBe(409);
    expect(again.body).toContain('PAYROLL_RUN_FROZEN');
  });
});

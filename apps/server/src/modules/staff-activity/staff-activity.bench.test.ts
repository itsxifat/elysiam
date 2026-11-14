import { withOrg, withSystem } from '@elysium/db';
import { createTestUser, grantMembership } from '@elysium/db/testing';
import { addDays, businessDate } from '@elysium/domain';
import { dhakaDayStart } from '@elysium/domain/staff-activity';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The shared harness's timing and report (`scripts/bench.mjs`, the one every latency check uses).
import { bench, formatResult, writeResult } from '../../../../../scripts/bench.mjs';
import {
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { seedPendingOrder } from './staff-activity.testing.js';

/**
 * M57 check 5: the team table for 60 people over 31 days in p95 ≤ 1.5 s.
 *
 * Run by `pnpm bench staff-activity` (it sets `ELYSIUM_BENCH=staff-activity`); skipped in
 * `pnpm test`, because it seeds a month of a busy brand and takes minutes. Not a tsx script like
 * the catalog bench: the routes need Nest's dependency injection, which needs the decorator
 * metadata only the test build emits.
 *
 * The month (D-1007): 40 sales agents and 20 at the hub; 1,500 orders a day (45,000), each created
 * and confirmed with one or two call attempts, 5 % with a call-back and 4 % cancelled; 3,000
 * conversations with 60 messages each (180,000); 1,500 Envo calls a day (45,000); 1,200 packings
 * a day (36,000) with three scans each, a lot closed and a handover scan; and each person's
 * presence in sixteen spans a day. Bulk SQL, not the routes: the packing triggers that check a
 * session's order move are switched off for the seed (as the tables' owner) and on again before
 * a single sample is taken.
 */

const RUN = process.env.ELYSIUM_BENCH === 'staff-activity';
const BUDGET_MS = 1500;
const DAYS = 31;
const ORDERS = 45_000;
const CONVERSATIONS = 3_000;
const MESSAGES_PER_CONVERSATION = 60;
const CALLS = 45_000;
const PACKINGS = 36_000;

let harness: HttpHarness;
let admin: RoleClient;
const agents: string[] = [];
const packers: string[] = [];
const to = businessDate(new Date());
const from = addDays(to, -(DAYS - 1));

async function seed(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const user = await createTestUser({ name: `Bench agent ${String(i)}` });
    await grantMembership({ userId: user.id, orgId: ORG_A, role: 'sales' });
    agents.push(user.id);
  }
  for (let i = 0; i < 20; i += 1) {
    const user = await createTestUser({ name: `Bench packer ${String(i)}` });
    await grantMembership({ userId: user.id, orgId: ORG_A, role: 'warehouse' });
    packers.push(user.id);
  }
  const template = await seedPendingOrder(ORG_A, agents[0] ?? '');
  const start = dhakaDayStart(from).toISOString();
  const agentList = sql`${sql.param(agents)}::text[]`;
  const packerList = sql`${sql.param(packers)}::text[]`;
  // A moment in the month: day `d` (0-based), at 09:00 Dhaka plus `minutes`.
  const at = (day: ReturnType<typeof sql>, minutes: ReturnType<typeof sql>) =>
    sql`(${start}::timestamptz + make_interval(days => (${day})::int, mins => 540 + (${minutes})::int))`;

  await withSystem(
    async (tx) => {
      for (const table of [
        'sales.orders',
        'packing.sessions',
        'packing.scans',
        'packing.lot_closures',
      ]) {
        await tx.execute(sql.raw(`alter table ${table} disable trigger user`));
      }
      await tx.execute(sql`
        insert into sales.orders (
          org_id, order_no, channel, customer_id, ship_name, ship_phone_e164, ship_district_id,
          ship_thana_id, ship_address_line, items_poisha, discount_poisha, delivery_charge_poisha,
          advance_paid_poisha, cod_amount_poisha, status, assigned_to, assigned_at, created_by,
          created_at, confirmed_by, confirmed_at)
        select o.org_id, 'BEN-2611-' || lpad(n::text, 6, '0'), o.channel, o.customer_id, o.ship_name,
               o.ship_phone_e164, o.ship_district_id, o.ship_thana_id, o.ship_address_line,
               100000, 0, 6000, 0, 106000,
               (case when n % 25 = 0 then 'cancelled' when n % 3 = 0 then 'delivered'
                     else 'confirmed' end)::sales.order_status,
               (${agentList})[1 + n % 40], ${at(sql`n % ${DAYS}`, sql`n % 700`)},
               (${agentList})[1 + n % 40], ${at(sql`n % ${DAYS}`, sql`n % 700`)},
               (${agentList})[1 + n % 40], ${at(sql`n % ${DAYS}`, sql`n % 700 + 20`)}
        from generate_series(1, ${ORDERS}) n
        cross join (select * from sales.orders where org_id = ${ORG_A} and id = ${template.id}) o
      `);
      await tx.execute(sql`
        insert into sales.order_lines (org_id, order_id, sku_id, sku_code, product_name, qty,
          unit_price_poisha, discount_poisha, delivered_qty, returned_qty, position)
        select o.org_id, o.id, l.sku_id, l.sku_code, l.product_name, 2, 50000, 0, 0, 0, 0
        from sales.orders o
        cross join (select * from sales.order_lines where org_id = ${ORG_A} and order_id = ${template.id}) l
        where o.org_id = ${ORG_A} and o.order_no like 'BEN-%'
      `);
      await tx.execute(sql`
        insert into sales.order_events (org_id, order_id, from_status, to_status, trigger,
          actor_user_id, business_date, occurred_at)
        select org_id, id, null::sales.order_status, 'pending'::sales.order_status, 'create',
               created_by, created_at::date, created_at
        from sales.orders where org_id = ${ORG_A} and order_no like 'BEN-%'
        union all
        select org_id, id, 'pending'::sales.order_status, 'confirmed'::sales.order_status, 'confirm',
               confirmed_by, confirmed_at::date,
               confirmed_at
        from sales.orders where org_id = ${ORG_A} and order_no like 'BEN-%'
        union all
        select org_id, id, 'confirmed'::sales.order_status, 'cancelled'::sales.order_status, 'cancel',
               confirmed_by, confirmed_at::date,
               confirmed_at + interval '2 hours'
        from sales.orders where org_id = ${ORG_A} and order_no like 'BEN-%' and status = 'cancelled'
      `);
      await tx.execute(sql`
        insert into sales.call_attempts (org_id, order_id, outcome, call_back_at, called_by, called_at)
        select org_id, id,
               case when right(order_no, 2)::int % 20 = 0 then 'call_back' else 'reached' end,
               case when right(order_no, 2)::int % 20 = 0 then confirmed_at - interval '5 minutes' end,
               confirmed_by, confirmed_at - interval '10 minutes'
        from sales.orders where org_id = ${ORG_A} and order_no like 'BEN-%'
        union all
        select org_id, id, 'no_answer', null, confirmed_by, confirmed_at - interval '15 minutes'
        from sales.orders where org_id = ${ORG_A} and order_no like 'BEN-%'
          and right(order_no, 1)::int % 2 = 0
      `);

      const channel = (
        await tx.execute<{ id: string }>(sql`
          insert into inbox.channels (org_id, kind, external_id, updated_by)
          values (${ORG_A}, 'messenger', '5550001', 'bench') returning id
        `)
      )[0]?.id;
      await tx.execute(sql`
        with c as (
          insert into inbox.contacts (org_id) select ${ORG_A} from generate_series(1, ${CONVERSATIONS})
          returning id
        ), i as (
          insert into inbox.identities (org_id, contact_id, channel_id, external_user_id)
          select ${ORG_A}, c.id, ${channel}, 'bench-' || row_number() over () from c
          returning id, contact_id
        )
        insert into inbox.conversations (org_id, channel_id, contact_id, identity_id, assigned_to, assigned_at)
        select ${ORG_A}, ${channel}, i.contact_id, i.id,
               (${agentList})[1 + (row_number() over ())::int % 40], ${start}::timestamptz
        from i
      `);
      await tx.execute(sql`
        insert into inbox.messages (org_id, conversation_id, direction, status, body, sent_by, occurred_at)
        select c.org_id, c.id,
               case when g % 2 = 1 then 'inbound' else 'outbound' end,
               case when g % 2 = 1 then 'received' else 'sent' end,
               'bench', case when g % 2 = 0 then c.assigned_to end,
               ${start}::timestamptz + make_interval(hours => g * 12, mins => 540 + (g * 7) % 40)
        from inbox.conversations c
        cross join generate_series(1, ${MESSAGES_PER_CONVERSATION}) g
        where c.org_id = ${ORG_A} and c.channel_id = ${channel}
      `);

      const connection = (
        await tx.execute<{ id: string }>(sql`
          insert into telephony.connections (org_id, name, base_url, created_by, updated_by)
          values (${ORG_A}, 'Bench PBX', 'https://pbx.bench', 'bench', 'bench') returning id
        `)
      )[0]?.id;
      await tx.execute(sql`
        insert into telephony.extension_assignments (org_id, connection_id, extension, user_id, assigned_by)
        select ${ORG_A}, ${connection}, (300 + n)::text, (${agentList})[n], 'bench'
        from generate_series(1, 40) n
      `);
      await tx.execute(sql`
        insert into telephony.calls (org_id, connection_id, envo_call_id, first_seen, direction,
          status, extension, user_id, answered, disposition, talk_seconds, occurred_at, ended_at)
        select ${ORG_A}, ${connection}, (1731000000 + n)::text || '.1', 'webhook',
               case when n % 4 = 0 then 'inbound' else 'outbound' end, 'ended',
               (300 + 1 + n % 40)::text,
               case when n % 4 = 0 and n % 12 = 0 then null else (${agentList})[1 + n % 40] end,
               not (n % 4 = 0 and n % 12 = 0),
               case when n % 4 = 0 and n % 12 = 0 then 'no_answer' else 'answered' end,
               60 + n % 240,
               ${at(sql`n % ${DAYS}`, sql`n % 700`)},
               ${at(sql`n % ${DAYS}`, sql`n % 700 + 4`)}
        from generate_series(1, ${CALLS}) n
      `);

      await tx.execute(sql`
        insert into packing.sessions (org_id, order_id, order_no, kind, status, video_required,
          started_by, started_at, completed_by, completed_at)
        select o.org_id, o.id, o.order_no, 'pack', 'completed', false,
               (${packerList})[1 + (right(o.order_no, 3)::int % 20)],
               o.confirmed_at + interval '3 hours',
               (${packerList})[1 + (right(o.order_no, 3)::int % 20)],
               o.confirmed_at + interval '3 hours 4 minutes'
        from sales.orders o
        where o.org_id = ${ORG_A} and o.order_no like 'BEN-%' and o.status <> 'cancelled'
        limit ${PACKINGS}
      `);
      await tx.execute(sql`
        insert into packing.scans (org_id, session_id, scan_id, code, sku_id, outcome, scanned_by, scanned_at)
        select s.org_id, s.id, gen_random_uuid(), 'CODE', l.sku_id,
               case when g = 3 and right(s.order_no, 2)::int % 20 = 0 then 'wrong_variant'
                    else 'accepted' end,
               s.completed_by, s.started_at + make_interval(secs => g * 30)
        from packing.sessions s
        join sales.order_lines l on l.org_id = s.org_id and l.order_id = s.order_id
        cross join generate_series(1, 3) g
        where s.org_id = ${ORG_A} and s.order_no like 'BEN-%'
      `);
      await tx.execute(sql`
        insert into packing.lot_closures (org_id, session_id, lot_no, closed_by, closed_at)
        select org_id, id, 1, completed_by, completed_at
        from packing.sessions where org_id = ${ORG_A} and order_no like 'BEN-%'
      `);
      await tx.execute(sql`
        insert into packing.handover_scans (org_id, order_id, lot_no, code, scanned_by, scanned_at)
        select org_id, order_id, 1, order_no, completed_by, completed_at + interval '2 hours'
        from packing.sessions where org_id = ${ORG_A} and order_no like 'BEN-%'
      `);
      for (const table of [
        'sales.orders',
        'packing.sessions',
        'packing.scans',
        'packing.lot_closures',
      ]) {
        await tx.execute(sql.raw(`alter table ${table} enable trigger user`));
      }

      // Sixteen half-hour spans a day for each person, alternating active and idle.
      await tx.execute(sql`
        insert into team.presence_spans (org_id, user_id, state, paused, started_at, ended_at)
        select ${ORG_A}, u, case when s % 2 = 0 then 'active' else 'idle' end, false,
               ${at(sql`d`, sql`s * 30`)}, ${at(sql`d`, sql`s * 30 + 30`)}
        from unnest(${agentList} || ${packerList}) u
        cross join generate_series(0, ${DAYS - 1}) d
        cross join generate_series(0, 15) s
      `);
    },
    { orgId: ORG_A },
  );

  await withSystem(async (tx) => {
    for (const table of [
      'sales.orders',
      'sales.order_lines',
      'sales.order_events',
      'sales.call_attempts',
      'inbox.messages',
      'inbox.conversations',
      'telephony.calls',
      'packing.sessions',
      'packing.scans',
      'packing.lot_closures',
      'packing.handover_scans',
      'team.presence_spans',
    ]) {
      await tx.execute(sql.raw(`analyze ${table}`));
    }
  });
}

describe.skipIf(!RUN)('M57 check 5: staff activity at a busy brand’s month', () => {
  beforeAll(async () => {
    process.env.LOG_LEVEL = 'fatal';
    harness = await startHttpHarness('staff-activity-bench');
    admin = await harness.asRole('org_admin', ORG_A);
    await seed();
  }, 1_800_000);

  afterAll(async () => {
    await harness?.close();
  }, 60_000);

  it('serves the team table, a person, their day and the mistakes within budget', async () => {
    const counts = await withOrg({ orgId: ORG_A, userId: 'bench' }, async (tx) => {
      const rows = await tx.execute<{
        orders: number;
        messages: number;
        calls: number;
        packings: number;
      }>(sql`
        select (select count(*) from sales.orders where order_no like 'BEN-%')::int as orders,
               (select count(*) from inbox.messages)::int as messages,
               (select count(*) from telephony.calls)::int as calls,
               (select count(*) from packing.sessions where order_no like 'BEN-%')::int as packings
      `);
      return rows[0];
    });
    process.stdout.write(
      `seeded ${JSON.stringify(counts)} for 60 people over ${String(DAYS)} days\n`,
    );
    expect(counts?.orders).toBe(ORDERS);

    const q = `from=${from}&to=${to}`;
    const get = async (url: string) => {
      const response = await admin.client.request('GET', url);
      if (response.statusCode !== 200) throw new Error(`${url}: ${String(response.statusCode)}`);
    };
    const agent = agents[7] ?? '';
    const results = [
      await bench({
        name: 'staff activity: team table, 60 people x 31 days',
        warmup: 2,
        samples: 20,
        budgetMs: BUDGET_MS,
        fn: () => get(`/v1/staff-activity/team?${q}`),
      }),
      await bench({
        name: 'staff activity: a person, 31 days, with the last period and comparison',
        warmup: 2,
        samples: 10,
        fn: () => get(`/v1/staff-activity/people/${agent}?${q}`),
      }),
      await bench({
        name: 'staff activity: a person’s timeline, one day',
        warmup: 2,
        samples: 20,
        fn: () => get(`/v1/staff-activity/people/${agent}/timeline?from=${to}&to=${to}`),
      }),
      await bench({
        name: 'staff activity: mistakes, 31 days',
        warmup: 2,
        samples: 10,
        fn: () => get(`/v1/staff-activity/mistakes?${q}`),
      }),
    ];
    for (const result of results) {
      process.stdout.write(`${formatResult(result)}\n`);
      writeResult(result);
    }
    expect(results[0]?.withinBudget).toBe(true);
  }, 1_800_000);
});

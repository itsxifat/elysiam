import { findCostFields } from '@elysium/contracts';
import { withGlobal, withSystem } from '@elysium/db';
import { addDays, businessDate } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
  type InjectedResponse,
  type RoleClient,
} from '../../testing/http-harness.js';
import { STAFF_ACTIVITY_API, type StaffActivityApi } from './staff-activity.api.js';
import { warehouseId } from '../inventory/inventory.testing.js';
import { ownRiderCourier } from '../orders/orders.testing.js';
import { seedMissedCallBack, seedPendingOrder } from './staff-activity.testing.js';

/**
 * M57 on real PostgreSQL, through the real routes: the team table against direct SQL on every
 * desk's source tables (check 1), the mistakes with their evidence and reviews (check 3), who may
 * see what (check 4) and the comparison table with names shown and hidden (check 7).
 *
 * The activity is a few hours of one morning in Elysiam, written into each module's own tables
 * the way their services leave them: orders and their events, call attempts, an inbox
 * conversation, Envo calls, a packing and a return session with their scans, lots and a handover
 * scan, and presence spans. The period is yesterday to today, so a run just after midnight in
 * Dhaka still holds every row (nothing is seeded more than six hours back).
 */

let harness: HttpHarness;
let admin: RoleClient;
let hr: RoleClient;
let rahim: RoleClient; // sales: orders and the inbox
let karim: RoleClient; // sales: calls, and a missed call-back
let parvin: RoleClient; // warehouse: packing and returns
let otherBrand: RoleClient;

const today = businessDate(new Date());
const PERIOD = { from: addDays(today, -1), to: today };
const Q = `from=${PERIOD.from}&to=${PERIOD.to}`;
const SECRET_BODY = 'SECRET-BODY-TEXT-not-for-the-page';
const CUSTOMER_PHONE = '+8801711987654';

const ids = {
  confirmedCalled: '',
  confirmedUncalled: '',
  cancelled: '',
  packed: '',
  conversation: '',
  slowMessage: '',
  missedCallBack: '',
  missedCall: '',
  unwrappedCall: '',
  wrongScan: '',
  packingSession: '',
  slowReplyMessage: '',
  expiredOffer: '',
  wrongItemReturn: '',
  wrongAddressReturn: '',
};

function body<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

async function system<T>(
  work: (tx: Parameters<Parameters<typeof withSystem>[0]>[0]) => Promise<T>,
) {
  return withSystem(work, { orgId: ORG_A });
}

async function one<T extends Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<T> {
  return system(async (tx) => {
    const rows = await tx.execute<T>(query);
    const row = rows[0];
    if (row === undefined) throw new Error('no row');
    return row as T;
  });
}

async function event(
  orderId: string,
  actor: string,
  trigger: string,
  from: string | null,
  to: string,
  ago: string,
) {
  await system((tx) =>
    tx.execute(sql`
      insert into sales.order_events
        (org_id, order_id, from_status, to_status, trigger, actor_user_id, business_date, occurred_at)
      values (${ORG_A}, ${orderId}, ${from}::sales.order_status, ${to}::sales.order_status,
              ${trigger}, ${actor}, (now() - ${ago}::interval)::date, now() - ${ago}::interval)
    `),
  );
}

async function seedOrders(): Promise<void> {
  // Rahim creates three orders, confirms two (one after a call that reached the buyer, one with
  // no call at all) and cancels the third.
  const a = await seedPendingOrder(ORG_A, rahim.userId);
  const b = await seedPendingOrder(ORG_A, rahim.userId);
  const c = await seedPendingOrder(ORG_A, rahim.userId);
  ids.confirmedCalled = a.id;
  ids.confirmedUncalled = b.id;
  ids.cancelled = c.id;
  for (const order of [a, b, c])
    await event(order.id, rahim.userId, 'create', null, 'pending', '5 hours');
  // The first was handed to him from the queue a minute after it came in.
  await system((tx) =>
    tx.execute(sql`
      update sales.orders set assigned_at = now() - interval '4 hours 59 minutes'
      where org_id = ${ORG_A} and id = ${a.id}
    `),
  );
  await system((tx) =>
    tx.execute(sql`
      insert into sales.call_attempts (org_id, order_id, outcome, called_by, called_at)
      values (${ORG_A}, ${a.id}, 'no_answer', ${rahim.userId}, now() - interval '4 hours 30 minutes'),
             (${ORG_A}, ${a.id}, 'reached', ${rahim.userId}, now() - interval '4 hours')
    `),
  );
  for (const order of [a, b]) {
    await system((tx) =>
      tx.execute(sql`
        update sales.orders set confirmed_by = ${rahim.userId},
               confirmed_at = now() - interval '3 hours 50 minutes'
        where org_id = ${ORG_A} and id = ${order.id}
      `),
    );
    await event(order.id, rahim.userId, 'confirm', 'pending', 'confirmed', '3 hours 50 minutes');
  }
  await event(c.id, rahim.userId, 'cancel', 'pending', 'cancelled', '3 hours');
}

async function seedInbox(): Promise<void> {
  // A Messenger conversation Rahim has held for six hours: answered in 10 minutes once, then left
  // for two hours (Settings below makes the whole day working hours, so the clock never pauses).
  const conversation = await system(async (tx) => {
    const channel = await tx.execute<{ id: string }>(sql`
      insert into inbox.channels (org_id, kind, external_id, updated_by)
      values (${ORG_A}, 'messenger', '1029384756', ${admin.userId}) returning id
    `);
    const contact = await tx.execute<{ id: string }>(sql`
      insert into inbox.contacts (org_id) values (${ORG_A}) returning id
    `);
    const identity = await tx.execute<{ id: string }>(sql`
      insert into inbox.identities (org_id, contact_id, channel_id, external_user_id)
      values (${ORG_A}, ${contact[0]?.id ?? ''}, ${channel[0]?.id ?? ''}, 'psid-staff-activity')
      returning id
    `);
    const row = await tx.execute<{ id: string }>(sql`
      insert into inbox.conversations
        (org_id, channel_id, contact_id, identity_id, assigned_to, assigned_at)
      values (${ORG_A}, ${channel[0]?.id ?? ''}, ${contact[0]?.id ?? ''}, ${identity[0]?.id ?? ''},
              ${rahim.userId}, now() - interval '6 hours')
      returning id
    `);
    await tx.execute(sql`
      insert into inbox.notes (org_id, contact_id, body, author_user_id)
      values (${ORG_A}, ${contact[0]?.id ?? ''}, 'Wants the blue one', ${rahim.userId})
    `);
    return row[0]?.id ?? '';
  });
  ids.conversation = conversation;
  const message = async (direction: string, ago: string, sentBy: string | null, text: string) =>
    one<{ id: string }>(sql`
      insert into inbox.messages (org_id, conversation_id, direction, status, body, sent_by, occurred_at)
      values (${ORG_A}, ${conversation}, ${direction},
              ${direction === 'inbound' ? 'received' : 'sent'}, ${text}, ${sentBy},
              now() - ${ago}::interval)
      returning id
    `);
  await message('inbound', '5 hours', null, SECRET_BODY);
  await message('outbound', '4 hours 50 minutes', rahim.userId, 'Hello!');
  ids.slowMessage = (await message('inbound', '3 hours', null, SECRET_BODY)).id;
  await message('outbound', '1 hour', rahim.userId, 'Sorry for the wait');
  // A third wait, answered in 20 minutes: slow (over 15), not unanswered (under 60).
  ids.slowReplyMessage = (await message('inbound', '40 minutes', null, SECRET_BODY)).id;
  await message('outbound', '20 minutes', rahim.userId, 'Here it is');
}

async function seedCalls(): Promise<void> {
  // Karim's extension 201: an outbound call answered for two minutes and never wrapped up, and
  // an inbound call nobody answered while he was active.
  const connection = await one<{ id: string }>(sql`
    insert into telephony.connections (org_id, name, base_url, created_by, updated_by)
    values (${ORG_A}, 'Office PBX', 'https://pbx.example', ${admin.userId}, ${admin.userId})
    returning id
  `);
  await system((tx) =>
    tx.execute(sql`
      insert into telephony.extension_assignments (org_id, connection_id, extension, user_id, assigned_by)
      values (${ORG_A}, ${connection.id}, '201', ${karim.userId}, ${admin.userId})
    `),
  );
  ids.unwrappedCall = (
    await one<{ id: string }>(sql`
      insert into telephony.calls
        (org_id, connection_id, envo_call_id, first_seen, direction, status, extension, user_id,
         answered, disposition, talk_seconds, duration_seconds, occurred_at, started_at,
         answered_at, ended_at, customer_phone_e164)
      values (${ORG_A}, ${connection.id}, '1731000000.101', 'webhook', 'outbound', 'ended', '201', ${karim.userId},
              true, 'answered', 120, 130, now() - interval '2 hours', now() - interval '2 hours',
              now() - interval '2 hours', now() - interval '1 hour 58 minutes', ${CUSTOMER_PHONE})
      returning id
    `)
  ).id;
  ids.missedCall = (
    await one<{ id: string }>(sql`
      insert into telephony.calls
        (org_id, connection_id, envo_call_id, first_seen, direction, status, extension, answered,
         disposition, occurred_at, started_at, ended_at, customer_phone_e164)
      values (${ORG_A}, ${connection.id}, '1731000000.102', 'webhook', 'inbound', 'ended', '201', false, 'no_answer',
              now() - interval '1 hour', now() - interval '1 hour',
              now() - interval '59 minutes', ${CUSTOMER_PHONE})
      returning id
    `)
  ).id;
}

async function seedPacking(): Promise<void> {
  // Parvin packs one order (two pieces, one wrong size refused first; video required and none
  // came), closes its lot, scans it to the courier, and closes one return at the station.
  const order = await seedPendingOrder(ORG_A, rahim.userId, 'confirmed');
  ids.packed = order.id;
  const moveOrder = async (orderId: string, status: string) =>
    system((tx) =>
      tx.execute(sql`
        update sales.orders set status = ${status}::sales.order_status
        where org_id = ${ORG_A} and id = ${orderId}
      `),
    );
  const sku = await one<{ sku_id: string }>(sql`
    select sku_id from sales.order_lines where org_id = ${ORG_A} and order_id = ${order.id} limit 1
  `);
  // A session opens, takes its scans and its lot, and only then completes (the packing triggers).
  const open = async (
    orderId: string,
    orderNo: string,
    kind: string,
    video: boolean,
    ago: string,
  ) =>
    one<{ id: string }>(sql`
      insert into packing.sessions
        (org_id, order_id, order_no, kind, status, video_required, started_by, started_at)
      values (${ORG_A}, ${orderId}, ${orderNo}, ${kind}, 'open', ${video}, ${parvin.userId},
              now() - ${ago}::interval)
      returning id
    `);
  const complete = async (sessionId: string, ago: string) =>
    system((tx) =>
      tx.execute(sql`
        update packing.sessions set status = 'completed', completed_by = ${parvin.userId},
               completed_at = now() - ${ago}::interval
        where org_id = ${ORG_A} and id = ${sessionId}
      `),
    );
  const session = await open(order.id, order.orderNo, 'pack', true, '3 hours 10 minutes');
  ids.packingSession = session.id;
  const scan = async (sessionId: string, outcome: string, n: number, ago: string) =>
    one<{ id: string }>(sql`
      insert into packing.scans
        (org_id, session_id, scan_id, code, sku_id, outcome, scanned_by, scanned_at)
      values (${ORG_A}, ${sessionId}, gen_random_uuid(), 'CODE',
              ${sku.sku_id}, ${outcome}, ${parvin.userId},
              now() - ${ago}::interval + ${`${String(n)} seconds`}::interval)
      returning id
    `);
  ids.wrongScan = (await scan(session.id, 'wrong_variant', 1, '3 hours 5 minutes')).id;
  await scan(session.id, 'accepted', 2, '3 hours 5 minutes');
  await scan(session.id, 'accepted', 3, '3 hours 5 minutes');
  await system((tx) =>
    tx.execute(sql`
      insert into packing.lot_closures (org_id, session_id, lot_no, closed_by, closed_at)
      values (${ORG_A}, ${session.id}, 1, ${parvin.userId}, now() - interval '3 hours 1 minute')
    `),
  );
  await moveOrder(order.id, 'packed');
  await complete(session.id, '3 hours');
  await system((tx) =>
    tx.execute(sql`
      insert into packing.handover_scans (org_id, order_id, lot_no, code, scanned_by, scanned_at)
      values (${ORG_A}, ${order.id}, 1, ${order.orderNo}, ${parvin.userId}, now() - interval '2 hours')
    `),
  );
  const back = await seedPendingOrder(ORG_A, rahim.userId, 'return_in_transit');
  const returned = await open(back.id, back.orderNo, 'return', false, '1 hour 10 minutes');
  await scan(returned.id, 'accepted', 9, '1 hour 5 minutes');
  await system((tx) =>
    tx.execute(sql`
      insert into sales.order_returns (org_id, order_id, kind, reason_code, business_date, recorded_by)
      values (${ORG_A}, ${back.id}, 'return', 'changed_mind', current_date, ${parvin.userId})
    `),
  );
  await moveOrder(back.id, 'returned');
  await complete(returned.id, '1 hour');
}

/**
 * The rest of the rules through their real SQL: the order Rahim confirmed without a call is
 * cancelled later and comes back for a wrong address; the order Parvin packed comes back as the
 * wrong item; Rahim accepts an offer and Karim lets one run out.
 */
async function seedAfterwards(): Promise<void> {
  await event(ids.confirmedUncalled, admin.userId, 'cancel', 'confirmed', 'cancelled', '2 hours');
  const recordReturn = (orderId: string, reason: string) =>
    one<{ id: string }>(sql`
      insert into sales.order_returns (org_id, order_id, kind, reason_code, business_date, recorded_by)
      values (${ORG_A}, ${orderId}, 'return', ${reason}, current_date, ${parvin.userId})
      returning id
    `);
  ids.wrongAddressReturn = (await recordReturn(ids.confirmedUncalled, 'wrong_address')).id;
  ids.wrongItemReturn = (await recordReturn(ids.packed, 'wrong_item')).id;
  await system((tx) =>
    tx.execute(sql`
      insert into sales.order_offers (org_id, order_id, user_id, status, offered_at, expires_at, responded_at)
      values (${ORG_A}, ${ids.cancelled}, ${rahim.userId}, 'accepted', now() - interval '5 hours',
              now() - interval '4 hours 58 minutes', now() - interval '4 hours 59 minutes')
    `),
  );
  ids.expiredOffer = (
    await one<{ id: string }>(sql`
      insert into sales.order_offers (org_id, order_id, user_id, status, offered_at, expires_at, responded_at)
      values (${ORG_A}, ${ids.confirmedCalled}, ${karim.userId}, 'expired', now() - interval '5 hours',
              now() - interval '4 hours 58 minutes', now() - interval '4 hours 58 minutes')
      returning id
    `)
  ).id;
}

/**
 * A returned parcel Parvin received (a consignment with a fake courier's account, its receipt and
 * one line of two sellable pieces), and an order Rahim confirmed that was delivered.
 */
async function seedReceiptAndDelivery(): Promise<void> {
  const courierId = await ownRiderCourier(ORG_A);
  const location = await warehouseId(ORG_A);
  const back = await seedPendingOrder(ORG_A, rahim.userId);
  const sku = await one<{ sku_id: string }>(sql`
    select sku_id from sales.order_lines where org_id = ${ORG_A} and order_id = ${back.id} limit 1
  `);
  await system(async (tx) => {
    const account = await tx.execute<{ id: string }>(sql`
      insert into courier.courier_accounts (org_id, courier_id, provider_code, label, is_active)
      values (${ORG_A}, ${courierId}, 'fake', 'Staff activity courier', true) returning id
    `);
    const consignment = await tx.execute<{ id: string }>(sql`
      insert into courier.consignments
        (org_id, order_id, courier_account_id, courier_id, reference, cod_amount_poisha, created_by)
      values (${ORG_A}, ${back.id}, ${account[0]?.id ?? ''}, ${courierId}, ${back.orderNo},
              106000, ${rahim.userId})
      returning id
    `);
    const receipt = await tx.execute<{ id: string }>(sql`
      insert into courier.return_receipts
        (org_id, consignment_id, order_id, location_id, received_at, business_date, received_by, reason)
      values (${ORG_A}, ${consignment[0]?.id ?? ''}, ${back.id}, ${location},
              now() - interval '50 minutes', current_date, ${parvin.userId}, 'customer_refused')
      returning id
    `);
    await tx.execute(sql`
      insert into courier.return_receipt_lines (org_id, receipt_id, sku_id, sellable_qty, damaged_qty)
      values (${ORG_A}, ${receipt[0]?.id ?? ''}, ${sku.sku_id}, 2, 0)
    `);
  });
  const delivered = await seedPendingOrder(ORG_A, rahim.userId, 'delivered');
  await system((tx) =>
    tx.execute(sql`
      update sales.orders set confirmed_by = ${rahim.userId},
             confirmed_at = now() - interval '4 hours 40 minutes'
      where org_id = ${ORG_A} and id = ${delivered.id}
    `),
  );
}

async function seedPresence(): Promise<void> {
  await system((tx) =>
    tx.execute(sql`
      insert into team.presence_spans (org_id, user_id, state, paused, started_at, ended_at) values
        (${ORG_A}, ${rahim.userId}, 'active', false, now() - interval '5 hours 30 minutes', now() - interval '3 hours'),
        (${ORG_A}, ${rahim.userId}, 'idle', false, now() - interval '3 hours', now() - interval '2 hours 30 minutes'),
        (${ORG_A}, ${karim.userId}, 'active', false, now() - interval '2 hours 30 minutes', now() - interval '30 minutes'),
        (${ORG_A}, ${parvin.userId}, 'active', true, now() - interval '3 hours 30 minutes', now() - interval '50 minutes')
    `),
  );
}

beforeAll(async () => {
  process.env.LOG_LEVEL = 'fatal';
  harness = await startHttpHarness('staff-activity');
  admin = await harness.asRole('org_admin', ORG_A);
  hr = await harness.asRole('hr', ORG_A);
  rahim = await harness.asRole('sales', ORG_A);
  karim = await harness.asRole('sales', ORG_A);
  parvin = await harness.asRole('warehouse', ORG_A);
  otherBrand = await harness.asRole('org_admin', ORG_B);
  for (const [who, name] of [
    [rahim, 'Rahim Uddin'],
    [karim, 'Karim Hossain'],
    [parvin, 'Parvin Akter'],
  ] as const) {
    await withGlobal((tx) =>
      tx.execute(sql`update iam.users set name = ${name} where id = ${who.userId}`),
    );
  }

  // Every minute of the day is working time here, so the inbox rule never pauses whatever the
  // hour the suite runs at.
  const settings = await admin.client.request('PUT', '/v1/staff-activity/settings', {
    body: {
      callBackGraceMinutes: 30,
      firstReplyMinutes: 15,
      unansweredMinutes: 60,
      wrapUpMinutes: 10,
      workdayStartMinute: 0,
      workdayEndMinute: 1440,
      requireVerificationCall: true,
      showColleagueNames: true,
      mistakesReduceBonuses: false,
    },
  });
  expect(settings.statusCode).toBe(200);

  await seedOrders();
  await seedInbox();
  await seedCalls();
  await seedPacking();
  await seedPresence();
  await seedAfterwards();
  await seedReceiptAndDelivery();
  ids.missedCallBack = (await seedMissedCallBack(ORG_A, karim.userId)).key;
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

interface Figures {
  presence: { activeMs: number; idleMs: number; pausedMs: number; onlineMs: number };
  orders: Record<string, number | string>;
  inbox: Record<string, number | null>;
  calls: Record<string, number>;
  packing: Record<string, number | null>;
  returns: Record<string, number>;
  actions: number;
  mistakes: number;
  mistakeRateTenths: number | null;
  deliveryRateBps: number | null;
}

interface TeamResponse {
  people: { person: { userId: string; name: string } | null; figures: Figures }[];
  medians: Record<string, number | null>;
  mistakesByKind: Record<string, number>;
}

async function teamFigures(): Promise<Map<string, Figures>> {
  const response = await admin.client.request('GET', `/v1/staff-activity/team?${Q}`);
  expect(response.statusCode).toBe(200);
  const table = body<TeamResponse>(response);
  return new Map(table.people.map((row) => [row.person?.userId ?? '', row.figures]));
}

/** Counts straight from the source tables, written independently of the module's SQL. */
/** The counts straight from the source tables (one row). */
interface DirectRow extends Record<string, unknown> {
  readonly created: number;
  readonly confirmed: number;
  readonly cancelled: number;
  readonly pieces_confirmed: number;
  readonly taken: number;
  readonly call_attempts: number;
  readonly messages_sent: number;
  readonly notes: number;
  readonly outbound: number;
  readonly talk_seconds: number;
  readonly missed: number;
  readonly packed: number;
  readonly returns_closed: number;
  readonly pieces_packed: number;
  readonly wrong_scans: number;
  readonly lots_closed: number;
  readonly handover_scans: number;
  readonly received: number;
  readonly pieces_received: number;
  readonly confirmed_delivered: number;
  readonly confirmed_returned: number;
  readonly active_ms: number;
  readonly idle_ms: number;
  readonly paused_ms: number;
  readonly conversations: number;
  readonly answered: number;
  readonly offers_accepted: number;
  readonly offers_expired: number;
  readonly returns_recorded: number;
  readonly median_pack_seconds: number | null;
}

async function direct(userId: string) {
  const from = sql`((${PERIOD.from}::date)::timestamp at time zone 'Asia/Dhaka')`;
  const to = sql`((${PERIOD.to}::date + 1)::timestamp at time zone 'Asia/Dhaka')`;
  return one<DirectRow>(sql`
    select
      (select count(*) from sales.order_events where org_id = ${ORG_A} and actor_user_id = ${userId}
         and trigger = 'create' and occurred_at >= ${from} and occurred_at < ${to})::int as created,
      (select count(*) from sales.order_events where org_id = ${ORG_A} and actor_user_id = ${userId}
         and trigger = 'confirm' and occurred_at >= ${from} and occurred_at < ${to})::int as confirmed,
      (select count(*) from sales.order_events where org_id = ${ORG_A} and actor_user_id = ${userId}
         and trigger = 'cancel' and occurred_at >= ${from} and occurred_at < ${to})::int as cancelled,
      (select coalesce(sum(l.qty), 0) from sales.orders o join sales.order_lines l
         on l.org_id = o.org_id and l.order_id = o.id
         where o.org_id = ${ORG_A} and o.confirmed_by = ${userId}
           and o.confirmed_at >= ${from} and o.confirmed_at < ${to})::int as pieces_confirmed,
      (select count(*) from sales.orders where org_id = ${ORG_A} and assigned_to = ${userId}
         and assigned_at >= ${from} and assigned_at < ${to})::int as taken,
      (select count(*) from sales.call_attempts where org_id = ${ORG_A} and called_by = ${userId}
         and called_at >= ${from} and called_at < ${to})::int as call_attempts,
      (select count(*) from inbox.messages where org_id = ${ORG_A} and sent_by = ${userId}
         and direction = 'outbound' and occurred_at >= ${from} and occurred_at < ${to})::int
         as messages_sent,
      (select count(*) from inbox.notes where org_id = ${ORG_A} and author_user_id = ${userId}
         and created_at >= ${from} and created_at < ${to})::int as notes,
      (select count(*) from telephony.calls where org_id = ${ORG_A} and user_id = ${userId}
         and direction = 'outbound' and occurred_at >= ${from} and occurred_at < ${to})::int
         as outbound,
      (select coalesce(sum(talk_seconds), 0) from telephony.calls where org_id = ${ORG_A}
         and user_id = ${userId} and occurred_at >= ${from} and occurred_at < ${to})::int
         as talk_seconds,
      (select count(*) from telephony.calls c join telephony.extension_assignments x
         on x.org_id = c.org_id and x.connection_id = c.connection_id and x.extension = c.extension
         where c.org_id = ${ORG_A} and x.user_id = ${userId} and c.direction = 'inbound'
           and not c.answered and c.occurred_at >= ${from} and c.occurred_at < ${to})::int
         as missed,
      (select count(*) from packing.sessions where org_id = ${ORG_A} and completed_by = ${userId}
         and kind = 'pack' and completed_at >= ${from} and completed_at < ${to})::int as packed,
      (select count(*) from packing.sessions where org_id = ${ORG_A} and completed_by = ${userId}
         and kind = 'return' and completed_at >= ${from} and completed_at < ${to})::int
         as returns_closed,
      (select count(*) from packing.scans c join packing.sessions s
         on s.org_id = c.org_id and s.id = c.session_id
         where c.org_id = ${ORG_A} and c.scanned_by = ${userId} and s.kind = 'pack'
           and c.outcome = 'accepted' and c.scanned_at >= ${from} and c.scanned_at < ${to})::int
         as pieces_packed,
      (select count(*) from packing.scans where org_id = ${ORG_A} and scanned_by = ${userId}
         and outcome in ('wrong_item', 'wrong_variant', 'over')
         and scanned_at >= ${from} and scanned_at < ${to})::int as wrong_scans,
      (select count(*) from packing.lot_closures where org_id = ${ORG_A} and closed_by = ${userId}
         and closed_at >= ${from} and closed_at < ${to})::int as lots_closed,
      (select count(*) from packing.handover_scans where org_id = ${ORG_A}
         and scanned_by = ${userId} and scanned_at >= ${from} and scanned_at < ${to})::int
         as handover_scans,
      (select count(*) from courier.return_receipts where org_id = ${ORG_A}
         and received_by = ${userId} and received_at >= ${from} and received_at < ${to})::int
         as received,
      (select coalesce(sum(l.sellable_qty + l.damaged_qty), 0) from courier.return_receipts r
         join courier.return_receipt_lines l on l.org_id = r.org_id and l.receipt_id = r.id
         where r.org_id = ${ORG_A} and r.received_by = ${userId}
           and r.received_at >= ${from} and r.received_at < ${to})::int as pieces_received,
      (select count(*) from sales.orders where org_id = ${ORG_A} and confirmed_by = ${userId}
         and confirmed_at >= ${from} and confirmed_at < ${to}
         and status in ('delivered', 'partially_delivered'))::int as confirmed_delivered,
      (select count(*) from sales.orders where org_id = ${ORG_A} and confirmed_by = ${userId}
         and confirmed_at >= ${from} and confirmed_at < ${to}
         and status in ('returned', 'return_in_transit'))::int as confirmed_returned,
      (select coalesce(sum(extract(epoch from (least(ended_at, ${to}) - greatest(started_at, ${from})))
         * 1000), 0) from team.presence_spans where org_id = ${ORG_A} and user_id = ${userId}
         and state = 'active' and ended_at > ${from} and started_at < ${to})::bigint as active_ms,
      (select coalesce(sum(extract(epoch from (least(ended_at, ${to}) - greatest(started_at, ${from})))
         * 1000), 0) from team.presence_spans where org_id = ${ORG_A} and user_id = ${userId}
         and state = 'idle' and ended_at > ${from} and started_at < ${to})::bigint as idle_ms,
      (select coalesce(sum(extract(epoch from (least(ended_at, ${to}) - greatest(started_at, ${from})))
         * 1000), 0) from team.presence_spans where org_id = ${ORG_A} and user_id = ${userId}
         and paused and ended_at > ${from} and started_at < ${to})::bigint as paused_ms,
      (select count(distinct conversation_id) from inbox.messages where org_id = ${ORG_A}
         and sent_by = ${userId} and direction = 'outbound'
         and occurred_at >= ${from} and occurred_at < ${to})::int as conversations,
      (select count(*) from telephony.calls where org_id = ${ORG_A} and user_id = ${userId}
         and answered and occurred_at >= ${from} and occurred_at < ${to})::int as answered,
      (select count(*) filter (where status = 'accepted') from sales.order_offers
         where org_id = ${ORG_A} and user_id = ${userId}
           and offered_at >= ${from} and offered_at < ${to})::int as offers_accepted,
      (select count(*) filter (where status = 'expired') from sales.order_offers
         where org_id = ${ORG_A} and user_id = ${userId}
           and offered_at >= ${from} and offered_at < ${to})::int as offers_expired,
      (select count(*) from sales.order_returns where org_id = ${ORG_A}
         and recorded_by = ${userId} and created_at >= ${from} and created_at < ${to})::int
         as returns_recorded,
      (select percentile_disc(0.5) within group (order by extract(epoch from (completed_at - started_at))::int)
         from packing.sessions where org_id = ${ORG_A} and completed_by = ${userId} and kind = 'pack'
           and completed_at >= ${from} and completed_at < ${to}) as median_pack_seconds
  `);
}

describe('check 1: every figure equals the source tables', () => {
  it('for the order desk, the inbox, the phones, the packing and return stations, and presence', async () => {
    const figures = await teamFigures();
    for (const person of [rahim, karim, parvin]) {
      const mine = figures.get(person.userId);
      expect(mine, person.userId).toBeDefined();
      const want = await direct(person.userId);
      expect({
        created: mine?.orders.created,
        confirmed: mine?.orders.confirmed,
        cancelled: mine?.orders.cancelled,
        piecesConfirmed: mine?.orders.piecesConfirmed,
        taken: mine?.orders.taken,
        callAttempts: mine?.orders.callAttempts,
        messagesSent: mine?.inbox.messagesSent,
        notes: mine?.inbox.notes,
        outbound: mine?.calls.outbound,
        talkSeconds: mine?.calls.talkSeconds,
        missed: mine?.calls.missed,
        packed: mine?.packing.packed,
        returnsClosed: mine?.packing.returnsClosed,
        piecesPacked: mine?.packing.piecesPacked,
        wrongScans: mine?.packing.wrongScans,
        lotsClosed: mine?.packing.lotsClosed,
        handoverScans: mine?.packing.handoverScans,
        received: mine?.returns.received,
        activeMs: mine?.presence.activeMs,
        idleMs: mine?.presence.idleMs,
        pausedMs: mine?.presence.pausedMs,
        onlineMs: mine?.presence.onlineMs,
        conversations: mine?.inbox.conversations,
        answered: mine?.calls.answered,
        offersAccepted: mine?.orders.offersAccepted,
        offersExpired: mine?.orders.offersExpired,
        returnsRecorded: mine?.orders.returnsRecorded,
        medianPackSeconds: mine?.packing.medianPackSeconds,
        piecesReceived: mine?.returns.piecesReceived,
        deliveryRateBps: mine?.deliveryRateBps,
        actions: mine?.actions,
      }).toEqual({
        created: want.created,
        confirmed: want.confirmed,
        cancelled: want.cancelled,
        piecesConfirmed: want.pieces_confirmed,
        taken: want.taken,
        callAttempts: want.call_attempts,
        messagesSent: want.messages_sent,
        notes: want.notes,
        outbound: want.outbound,
        talkSeconds: want.talk_seconds,
        missed: want.missed,
        packed: want.packed,
        returnsClosed: want.returns_closed,
        piecesPacked: want.pieces_packed,
        wrongScans: want.wrong_scans,
        lotsClosed: want.lots_closed,
        handoverScans: want.handover_scans,
        received: want.received,
        activeMs: Number(want.active_ms),
        idleMs: Number(want.idle_ms),
        pausedMs: Number(want.paused_ms),
        onlineMs: Number(want.active_ms) + Number(want.idle_ms),
        conversations: want.conversations,
        answered: want.answered,
        offersAccepted: want.offers_accepted,
        offersExpired: want.offers_expired,
        returnsRecorded: want.returns_recorded,
        medianPackSeconds:
          want.median_pack_seconds === null ? null : Number(want.median_pack_seconds),
        piecesReceived: want.pieces_received,
        deliveryRateBps:
          want.confirmed_delivered + want.confirmed_returned === 0
            ? null
            : Math.round(
                (want.confirmed_delivered * 10_000) /
                  (want.confirmed_delivered + want.confirmed_returned),
              ),
        // The actions D-1006 counts, each from its own source row above.
        actions:
          want.created +
          want.confirmed +
          want.cancelled +
          want.call_attempts +
          want.returns_recorded +
          want.messages_sent +
          want.outbound +
          want.answered +
          want.packed +
          want.received,
      });
      // The mistakes column is the count of that person's mistakes the list shows, none reviewed.
      const listed = (await mistakesOf(admin)).filter((m) => m.userId === person.userId);
      expect(mine?.mistakes).toBe(listed.length);
      // And the rate is that count per 100 of the actions above, in tenths.
      const actions = mine?.actions ?? 0;
      expect(mine?.mistakeRateTenths).toBe(
        actions === 0 ? null : Math.round((listed.length * 1000) / actions),
      );
    }
    // The team median row: nearest rank over the people who did anything, from the rows.
    const table = body<TeamResponse>(
      await admin.client.request('GET', `/v1/staff-activity/team?${Q}`),
    );
    const workers = table.people.filter(
      (row) => row.figures.actions > 0 || row.figures.presence.onlineMs > 0,
    );
    const confirmedSorted = workers
      .map((row) => Number(row.figures.orders.confirmed))
      .sort((a, b) => a - b);
    expect(table.medians.ordersConfirmed).toBe(
      confirmedSorted[Math.max(1, Math.ceil(confirmedSorted.length / 2)) - 1],
    );
    // Not vacuous: the morning is really there.
    expect(figures.get(parvin.userId)?.returns.received).toBe(1);
    expect(figures.get(parvin.userId)?.returns.piecesReceived).toBe(2);
    expect(figures.get(rahim.userId)?.deliveryRateBps).toBe(10_000);
    const r = figures.get(rahim.userId);
    expect(r?.orders.taken).toBe(1);
    expect(r?.orders.confirmed).toBe(2);
    // Two pieces on each of the two confirmed this morning and on the one delivered since.
    expect(r?.orders.piecesConfirmed).toBe(6);
    expect(r?.inbox.messagesSent).toBe(3);
    expect(r?.inbox.firstReplies).toBe(3);
    expect(r?.orders.offersAccepted).toBe(1);
    expect(figures.get(karim.userId)?.orders.offersExpired).toBe(1);
    expect(figures.get(parvin.userId)?.orders.returnsRecorded).toBe(3);
    expect(figures.get(karim.userId)?.calls.talkSeconds).toBe(120);
    expect(figures.get(parvin.userId)?.packing.piecesPacked).toBe(2);
    expect(figures.get(parvin.userId)?.packing.returnsClosed).toBe(1);
    expect(figures.get(parvin.userId)?.presence.pausedMs).toBe(
      figures.get(parvin.userId)?.presence.activeMs,
    );
  }, 120_000);

  it('exports the same table as CSV', async () => {
    const response = await admin.client.request('GET', `/v1/staff-activity/team/export?${Q}`);
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'])).toContain('text/csv');
    expect(response.body).toContain('Pieces packed');
  });
});

interface MistakeItem {
  key: string;
  kind: string;
  userId: string;
  ref: { type: string; id: string; label: string | null };
  review: { status: string; note: string | null } | null;
}

async function mistakesOf(client: RoleClient, extra = ''): Promise<MistakeItem[]> {
  const response = await client.client.request('GET', `/v1/staff-activity/mistakes?${Q}${extra}`);
  expect(response.statusCode, response.body).toBe(200);
  return body<{ items: MistakeItem[] }>(response).items;
}

describe('check 3: mistakes, their evidence and their reviews', () => {
  it('finds each seeded mistake on the right person, linked to its evidence', async () => {
    const items = await mistakesOf(admin);
    const found = (key: string) => items.find((item) => item.key === key);
    expect(found(`confirmed_without_call:${ids.confirmedUncalled}`)).toMatchObject({
      userId: rahim.userId,
      ref: { type: 'order', id: ids.confirmedUncalled },
    });
    // The called order is no mistake.
    expect(found(`confirmed_without_call:${ids.confirmedCalled}`)).toBeUndefined();
    expect(found(`conversation_unanswered:${ids.slowMessage}`)).toMatchObject({
      userId: rahim.userId,
      ref: { type: 'conversation', id: ids.conversation },
    });
    expect(found(ids.missedCallBack)).toMatchObject({
      userId: karim.userId,
      ref: { type: 'order' },
    });
    expect(found(`missed_call:${ids.missedCall}`)).toMatchObject({
      userId: karim.userId,
      ref: { type: 'call', id: ids.missedCall },
    });
    expect(found(`call_not_wrapped_up:${ids.unwrappedCall}`)).toMatchObject({
      userId: karim.userId,
    });
    expect(found(`wrong_scan:${ids.wrongScan}`)).toMatchObject({
      userId: parvin.userId,
      ref: { type: 'order', id: ids.packed },
    });
    expect(found(`packed_without_video:${ids.packingSession}`)).toMatchObject({
      userId: parvin.userId,
    });
    // The other five rules, each through its own module's SQL.
    expect(found(`cancelled_after_confirm:${ids.confirmedUncalled}`)).toMatchObject({
      userId: rahim.userId,
      ref: { type: 'order', id: ids.confirmedUncalled },
    });
    expect(found(`address_not_verified:${ids.wrongAddressReturn}`)).toMatchObject({
      userId: rahim.userId,
      ref: { type: 'order', id: ids.confirmedUncalled },
    });
    expect(found(`wrong_item_shipped:${ids.wrongItemReturn}`)).toMatchObject({
      userId: parvin.userId,
      ref: { type: 'order', id: ids.packed },
    });
    expect(found(`slow_first_reply:${ids.slowReplyMessage}`)).toMatchObject({
      userId: rahim.userId,
      ref: { type: 'conversation', id: ids.conversation },
    });
    expect(found(`offer_timed_out:${ids.expiredOffer}`)).toMatchObject({
      userId: karim.userId,
      ref: { type: 'order', id: ids.confirmedCalled },
    });
    // Every one of the twelve kinds came up at least once.
    expect(new Set(items.map((item) => item.kind)).size).toBe(12);
  }, 60_000);

  it('a dismissed mistake leaves the counts and keeps its review and audit row', async () => {
    const key = `wrong_scan:${ids.wrongScan}`;
    const before = (await teamFigures()).get(parvin.userId)?.mistakes ?? 0;
    const review = await admin.client.request('PUT', '/v1/staff-activity/mistakes/review', {
      body: { key, ...PERIOD, status: 'dismissed', note: 'The station caught it' },
    });
    expect(review.statusCode, review.body).toBe(200);
    expect((await teamFigures()).get(parvin.userId)?.mistakes).toBe(before - 1);
    const item = (await mistakesOf(admin, '&status=dismissed')).find((m) => m.key === key);
    expect(item?.review).toMatchObject({ status: 'dismissed', note: 'The station caught it' });
    const audit = await one<{ n: number }>(sql`
      select count(*)::int as n from audit.audit_log
      where org_id = ${ORG_A} and action = 'staff_activity.mistake_reviewed' and entity_id = ${key}
    `);
    expect(audit.n).toBe(1);

    // Confirmed again: it counts again.
    const again = await admin.client.request('PUT', '/v1/staff-activity/mistakes/review', {
      body: { key, ...PERIOD, status: 'confirmed', note: null },
    });
    expect(again.statusCode).toBe(200);
    expect((await teamFigures()).get(parvin.userId)?.mistakes).toBe(before);
  }, 60_000);

  it('refuses a review of a mistake that is not there, and one from hr', async () => {
    const missing = await admin.client.request('PUT', '/v1/staff-activity/mistakes/review', {
      body: {
        key: 'wrong_scan:00000000-0000-4000-8000-000000000000',
        ...PERIOD,
        status: 'confirmed',
      },
    });
    expect(missing.statusCode).toBe(404);
    const byHr = await hr.client.request('PUT', '/v1/staff-activity/mistakes/review', {
      body: { key: `wrong_scan:${ids.wrongScan}`, ...PERIOD, status: 'dismissed' },
    });
    expect(byHr.statusCode).toBe(403);
  });
});

describe('check 4: who sees what', () => {
  it('a sales person sees their own page, never another person’s or the team table', async () => {
    const me = await karim.client.request('GET', `/v1/staff-activity/me?${Q}`);
    expect(me.statusCode, me.body).toBe(200);
    expect(
      (await karim.client.request('GET', `/v1/staff-activity/people/${karim.userId}?${Q}`))
        .statusCode,
    ).toBe(200);
    expect(
      (await karim.client.request('GET', `/v1/staff-activity/people/${rahim.userId}?${Q}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await karim.client.request('GET', `/v1/staff-activity/people/${rahim.userId}/timeline?${Q}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await karim.client.request('GET', `/v1/staff-activity/mistakes?${Q}&userId=${rahim.userId}`))
        .statusCode,
    ).toBe(404);
    const team = await karim.client.request('GET', `/v1/staff-activity/team?${Q}`);
    expect(team.statusCode).toBe(403);
    expect(team.body).toContain('STAFF_ACTIVITY_TEAM_ONLY');
    // Their own mistakes only.
    const mine = await mistakesOf(karim);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((m) => m.userId === karim.userId)).toBe(true);
    // hr reads everyone; nobody but org_admin sees the settings.
    expect((await hr.client.request('GET', `/v1/staff-activity/team?${Q}`)).statusCode).toBe(200);
    expect((await hr.client.request('GET', '/v1/staff-activity/settings')).statusCode).toBe(403);
  }, 60_000);

  it('no phone number, message body or cost field in any answer', async () => {
    const responses = [
      await admin.client.request('GET', `/v1/staff-activity/team?${Q}`),
      await admin.client.request('GET', `/v1/staff-activity/people/${rahim.userId}?${Q}`),
      await admin.client.request('GET', `/v1/staff-activity/people/${rahim.userId}/timeline?${Q}`),
      await admin.client.request('GET', `/v1/staff-activity/people/${karim.userId}/timeline?${Q}`),
      await admin.client.request('GET', `/v1/staff-activity/mistakes?${Q}`),
      await karim.client.request('GET', `/v1/staff-activity/me?${Q}`),
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(SECRET_BODY);
      expect(response.body).not.toContain(CUSTOMER_PHONE);
      expect(response.body).not.toContain('01711987654');
      expect(findCostFields(JSON.parse(response.body))).toEqual([]);
    }
  }, 60_000);

  it('another brand sees none of these people', async () => {
    const response = await otherBrand.client.request('GET', `/v1/staff-activity/team?${Q}`);
    expect(response.statusCode).toBe(200);
    const people = body<TeamResponse>(response).people.map((row) => row.person?.userId);
    for (const person of [rahim, karim, parvin]) expect(people).not.toContain(person.userId);
    expect(
      (await otherBrand.client.request('GET', `/v1/staff-activity/people/${rahim.userId}?${Q}`))
        .statusCode,
    ).toBe(404);
  });

  it('the timeline tells the morning in order, linked, with the idle stretch', async () => {
    const response = await admin.client.request(
      'GET',
      `/v1/staff-activity/people/${rahim.userId}/timeline?${Q}`,
    );
    const items = body<{ items: { kind: string; at: string; ref: { type: string } | null }[] }>(
      response,
    ).items;
    const kinds = items.map((item) => item.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'order.create',
        'order.confirm',
        'order.cancel',
        'order.call_attempt',
        'order.taken',
        'inbox.message_sent',
        'inbox.note',
        'presence.online',
        'presence.idle',
      ]),
    );
    const times = items.map((item) => Date.parse(item.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

interface PersonResponse {
  comparison: {
    desk: string | null;
    rows: {
      name: string | null;
      colleagueNo: number | null;
      isViewer: boolean;
      userId: string | null;
    }[];
  };
  days: { date: string; activeMs: number }[];
  heatmap: number[][];
}

describe('check 7: the comparison table', () => {
  it('shows a sales person their desk, names by default, ids only on their own row', async () => {
    const response = await karim.client.request('GET', `/v1/staff-activity/me?${Q}&desk=orders`);
    const page = body<PersonResponse>(response);
    expect(page.comparison.desk).toBe('orders');
    const mine = page.comparison.rows.find((row) => row.isViewer);
    expect(mine?.userId).toBe(karim.userId);
    const others = page.comparison.rows.filter((row) => !row.isViewer);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((row) => row.userId === null && row.name !== null)).toBe(true);
    expect(page.heatmap).toHaveLength(7);
    expect(page.days).toHaveLength(2);
  });

  it('hides colleagues’ names when the brand says so', async () => {
    const settings = await admin.client.request('GET', '/v1/staff-activity/settings');
    const current = body<Record<string, unknown>>(settings);
    delete current.saved;
    const save = await admin.client.request('PUT', '/v1/staff-activity/settings', {
      body: { ...current, showColleagueNames: false },
    });
    expect(save.statusCode).toBe(200);
    const page = body<PersonResponse>(
      await karim.client.request('GET', `/v1/staff-activity/me?${Q}&desk=orders`),
    );
    const others = page.comparison.rows.filter((row) => !row.isViewer);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((row) => row.name === null && row.colleagueNo !== null)).toBe(true);
    const rahimName = await one<{ name: string }>(
      sql`select name from iam.users where id = ${rahim.userId}`,
    );
    expect(JSON.stringify(page.comparison)).not.toContain(rahimName.name);
    // A supervisor reading Karim's page still sees the names and ids.
    const supervisor = body<PersonResponse>(
      await admin.client.request(
        'GET',
        `/v1/staff-activity/people/${karim.userId}?${Q}&desk=orders`,
      ),
    );
    expect(
      supervisor.comparison.rows.every((row) => row.name !== null && row.userId !== null),
    ).toBe(true);
  });
});

describe('the ledger audit’s cases', () => {
  it('a review answers only for the person it was made against (D-1017)', async () => {
    const key = `slow_first_reply:${ids.slowReplyMessage}`;
    const confirmed = await admin.client.request('PUT', '/v1/staff-activity/mistakes/review', {
      body: { key, ...PERIOD, status: 'confirmed', note: 'Rahim’s' },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    // The conversation is handed to Karim, as if he had held it all along: the rule now puts
    // the same wait on him, and Rahim's confirmed review must not come with it.
    const handOver = (to: string) =>
      system((tx) =>
        tx.execute(sql`
          update inbox.conversations set assigned_to = ${to}, assigned_at = now() - interval '6 hours'
          where org_id = ${ORG_A} and id = ${ids.conversation}
        `),
      );
    await handOver(karim.userId);
    try {
      const moved = (await mistakesOf(admin)).find((m) => m.key === key);
      expect(moved?.userId).toBe(karim.userId);
      expect(moved?.review).toBeNull();
      const forPay = await harness.app
        .get<{ confirmedMistakes: StaffActivityApi['confirmedMistakes'] }>(STAFF_ACTIVITY_API)
        .confirmedMistakes(ORG_A, PERIOD);
      // The switch is off here, so nothing counts for pay at all; with it on (bonus-mistakes),
      // only a review against the same person does. The list above is what matters.
      expect(forPay.enabled).toBe(false);
    } finally {
      await handOver(rahim.userId);
    }
    const back = (await mistakesOf(admin)).find((m) => m.key === key);
    expect(back).toMatchObject({ userId: rahim.userId, review: { status: 'confirmed' } });
  });

  it('staff compare on their own desk, whatever the address asks for', async () => {
    const page = body<PersonResponse>(
      await karim.client.request('GET', `/v1/staff-activity/me?${Q}&desk=packing`),
    );
    expect(page.comparison.desk).not.toBe('packing');
    const parvinName = await one<{ name: string }>(
      sql`select name from iam.users where id = ${parvin.userId}`,
    );
    expect(JSON.stringify(page.comparison)).not.toContain(parvinName.name);
  });

  it('a Replace (M50) is neither a cancel after confirming nor a confirmation without a call', async () => {
    const original = await seedPendingOrder(ORG_A, rahim.userId);
    const replacement = await seedPendingOrder(ORG_A, rahim.userId);
    await system(async (tx) => {
      await tx.execute(sql`
        update sales.orders set confirmed_by = ${rahim.userId}, confirmed_at = now() - interval '2 hours'
        where org_id = ${ORG_A} and id = ${original.id}
      `);
      await tx.execute(sql`
        update sales.orders set replaces_order_id = ${original.id}, confirmed_by = ${rahim.userId},
               confirmed_at = now() - interval '30 minutes'
        where org_id = ${ORG_A} and id = ${replacement.id}
      `);
      await tx.execute(sql`
        insert into sales.call_attempts (org_id, order_id, outcome, called_by, called_at)
        values (${ORG_A}, ${original.id}, 'reached', ${rahim.userId}, now() - interval '3 hours')
      `);
    });
    await event(original.id, rahim.userId, 'cancel', 'packed', 'cancelled', '30 minutes');
    const keys = (await mistakesOf(admin)).map((m) => m.key);
    expect(keys).not.toContain(`cancelled_after_confirm:${original.id}`);
    expect(keys).not.toContain(`confirmed_without_call:${replacement.id}`);
  });

  it('an org admin does not review their own mistake', async () => {
    const own = await seedMissedCallBack(ORG_A, admin.userId);
    const response = await admin.client.request('PUT', '/v1/staff-activity/mistakes/review', {
      body: { key: own.key, ...PERIOD, status: 'dismissed' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('STAFF_ACTIVITY_OWN_MISTAKE');
  });

  it('the team’s CSV is audited', async () => {
    const response = await admin.client.request('GET', `/v1/staff-activity/team/export?${Q}`);
    expect(response.statusCode).toBe(200);
    const audit = await one<{ n: number }>(sql`
      select count(*)::int as n from audit.audit_log
      where org_id = ${ORG_A} and actor_user_id = ${admin.userId}
        and action = 'staff_activity.exported'
    `);
    expect(audit.n).toBeGreaterThanOrEqual(2);
  });
});

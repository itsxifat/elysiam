import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The orders module's half of staff activity (M57, D-1006): who did what at the order desk in a
 * period, the candidate rows the mistake rules decide on, and one person's desk timeline.
 *
 * Only gathering. Every count is by the person on the row (`order_events.actor_user_id`,
 * `call_attempts.called_by`, …), every period is `[from, to)` on the instant, and nothing here
 * says what is a mistake: `detectMistakes` in `@elysium/domain/staff-activity` does.
 */

export interface Period {
  readonly from: Date;
  readonly to: Date;
}

const iso = (date: Date) => date.toISOString();

export interface EventCountRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly created: number;
  readonly confirmed: number;
  readonly cancelled: number;
}

/** Orders created, confirmed and cancelled by each person, from the order's events. */
export async function eventCounts(tx: Tx, orgId: string, period: Period): Promise<EventCountRow[]> {
  const rows = await tx.execute<EventCountRow>(sql`
    select e.actor_user_id as user_id,
           count(*) filter (where e.trigger = 'create')::int as created,
           count(*) filter (where e.trigger = 'confirm')::int as confirmed,
           count(*) filter (where e.trigger = 'cancel')::int as cancelled
    from sales.order_events e
    where e.org_id = ${orgId}
      and e.actor_user_id is not null
      and e.occurred_at >= ${iso(period.from)}::timestamptz
      and e.occurred_at < ${iso(period.to)}::timestamptz
      and e.trigger in ('create', 'confirm', 'cancel')
    group by 1
  `);
  return [...rows];
}

export interface ConfirmedRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly pieces: number;
  readonly value_poisha: string;
  readonly delivered: number;
  readonly returned: number;
}

/**
 * The orders each person confirmed in the period: their pieces, their net items (selling price
 * less the order's discount; never cost) and how many of them went on to be delivered or came
 * back.
 */
export async function confirmedOrders(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<ConfirmedRow[]> {
  const rows = await tx.execute<ConfirmedRow>(sql`
    select o.confirmed_by as user_id,
           coalesce(sum(l.pieces), 0)::int as pieces,
           coalesce(sum(o.items_poisha - o.discount_poisha), 0)::text as value_poisha,
           count(*) filter (where o.status in ('delivered', 'partially_delivered'))::int
             as delivered,
           count(*) filter (where o.status in ('returned', 'return_in_transit'))::int as returned
    from sales.orders o
    left join lateral (
      select sum(ol.qty) as pieces from sales.order_lines ol
      where ol.org_id = o.org_id and ol.order_id = o.id
    ) l on true
    where o.org_id = ${orgId}
      and o.confirmed_by is not null
      and o.confirmed_at >= ${iso(period.from)}::timestamptz
      and o.confirmed_at < ${iso(period.to)}::timestamptz
    group by 1
  `);
  return [...rows];
}

export interface PersonCountRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

/** Orders handed to each person in the period that are still theirs. */
export async function takenCounts(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<PersonCountRow[]> {
  const rows = await tx.execute<PersonCountRow>(sql`
    select o.assigned_to as user_id, count(*)::int as a, 0 as b, 0 as c
    from sales.orders o
    where o.org_id = ${orgId}
      and o.assigned_to is not null
      and o.assigned_at >= ${iso(period.from)}::timestamptz
      and o.assigned_at < ${iso(period.to)}::timestamptz
    group by 1
  `);
  return [...rows];
}

/** Call attempts (a) and those that reached the customer (b). */
export async function callAttemptCounts(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<PersonCountRow[]> {
  const rows = await tx.execute<PersonCountRow>(sql`
    select a.called_by as user_id,
           count(*)::int as a,
           count(*) filter (where a.outcome = 'reached')::int as b,
           0 as c
    from sales.call_attempts a
    where a.org_id = ${orgId}
      and a.called_at >= ${iso(period.from)}::timestamptz
      and a.called_at < ${iso(period.to)}::timestamptz
    group by 1
  `);
  return [...rows];
}

/** Offers accepted (a), declined (b) and left to expire (c), by when they were answered. */
export async function offerCounts(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<PersonCountRow[]> {
  const rows = await tx.execute<PersonCountRow>(sql`
    select f.user_id,
           count(*) filter (where f.status = 'accepted')::int as a,
           count(*) filter (where f.status = 'declined')::int as b,
           count(*) filter (where f.status = 'expired')::int as c
    from sales.order_offers f
    where f.org_id = ${orgId}
      and f.offered_at >= ${iso(period.from)}::timestamptz
      and f.offered_at < ${iso(period.to)}::timestamptz
      and f.status in ('accepted', 'declined', 'expired')
    group by 1
  `);
  return [...rows];
}

/** Returns and exchanges each person recorded on an order. */
export async function returnCounts(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<PersonCountRow[]> {
  const rows = await tx.execute<PersonCountRow>(sql`
    select r.recorded_by as user_id, count(*)::int as a, 0 as b, 0 as c
    from sales.order_returns r
    where r.org_id = ${orgId}
      and r.created_at >= ${iso(period.from)}::timestamptz
      and r.created_at < ${iso(period.to)}::timestamptz
    group by 1
  `);
  return [...rows];
}

// --- mistake candidates ------------------------------------------------------------------

export interface ReturnFactRow extends Record<string, unknown> {
  readonly return_id: string;
  readonly order_id: string;
  readonly order_no: string;
  readonly reason_code: string;
  readonly at: Date | string;
  readonly confirmed_by: string | null;
  readonly reached_before_confirm: number;
}

/** Returns recorded in the period with a reason a rule reads, and what the desk knew. */
export async function returnFacts(tx: Tx, orgId: string, period: Period): Promise<ReturnFactRow[]> {
  const rows = await tx.execute<ReturnFactRow>(sql`
    select r.id as return_id, o.id as order_id, o.order_no, r.reason_code,
           r.created_at as at, o.confirmed_by,
           (select count(*)::int from sales.call_attempts a
             where a.org_id = o.org_id and a.order_id = o.id and a.outcome = 'reached'
               and o.confirmed_at is not null and a.called_at <= o.confirmed_at)
             as reached_before_confirm
    from sales.order_returns r
    join sales.orders o on o.org_id = r.org_id and o.id = r.order_id
    where r.org_id = ${orgId}
      and r.created_at >= ${iso(period.from)}::timestamptz
      and r.created_at < ${iso(period.to)}::timestamptz
      and r.reason_code in ('wrong_item', 'wrong_address', 'customer_unreachable')
  `);
  return [...rows];
}

export interface ConfirmationRow extends Record<string, unknown> {
  readonly order_id: string;
  readonly order_no: string;
  readonly confirmed_by: string;
  readonly confirmed_at: Date | string;
  readonly attempts_before_confirm: number;
  readonly channel: string;
}

/** Orders confirmed in the period with no call attempt before it (the rule's candidates). */
export async function uncalledConfirmations(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<ConfirmationRow[]> {
  const rows = await tx.execute<ConfirmationRow>(sql`
    select o.id as order_id, o.order_no, o.confirmed_by, o.confirmed_at,
           0 as attempts_before_confirm, o.channel::text as channel
    from sales.orders o
    where o.org_id = ${orgId}
      and o.confirmed_by is not null
      and o.confirmed_at >= ${iso(period.from)}::timestamptz
      and o.confirmed_at < ${iso(period.to)}::timestamptz
      and not exists (
        select 1 from sales.call_attempts a
        where a.org_id = o.org_id and a.order_id = o.id and a.called_at <= o.confirmed_at
      )
      -- A replacement or an exchange (M50) carries the verification of the order it replaces.
      and o.replaces_order_id is null
  `);
  return [...rows];
}

export interface CancelRow extends Record<string, unknown> {
  readonly order_id: string;
  readonly order_no: string;
  readonly confirmed_by: string;
  readonly cancelled_at: Date | string;
  readonly cancelled_by: string | null;
}

/** Orders cancelled in the period after being confirmed, before they left with the courier. */
export async function cancelsAfterConfirm(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<CancelRow[]> {
  const rows = await tx.execute<CancelRow>(sql`
    select o.id as order_id, o.order_no, o.confirmed_by,
           e.occurred_at as cancelled_at, e.actor_user_id as cancelled_by
    from sales.order_events e
    join sales.orders o on o.org_id = e.org_id and o.id = e.order_id
    where e.org_id = ${orgId}
      and e.trigger = 'cancel'
      and e.from_status in ('confirmed', 'on_hold', 'packed')
      and e.occurred_at >= ${iso(period.from)}::timestamptz
      and e.occurred_at < ${iso(period.to)}::timestamptz
      and o.confirmed_by is not null
      -- Replaced (M50): the customer changed the order, nobody let a bad one through.
      and not exists (
        select 1 from sales.orders r
        where r.org_id = o.org_id and r.replaces_order_id = o.id
      )
  `);
  return [...rows];
}

export interface CallBackRow extends Record<string, unknown> {
  readonly attempt_id: string;
  readonly order_id: string;
  readonly order_no: string;
  readonly set_by: string;
  readonly call_back_at: Date | string;
  readonly next_attempt_at: Date | string | null;
  readonly settled_at: Date | string | null;
}

/** Call-backs that fell due in the period, with what happened next on the order. */
export async function callBacks(tx: Tx, orgId: string, period: Period): Promise<CallBackRow[]> {
  const rows = await tx.execute<CallBackRow>(sql`
    select a.id as attempt_id, o.id as order_id, o.order_no, a.called_by as set_by,
           a.call_back_at,
           (select min(n.called_at) from sales.call_attempts n
             where n.org_id = a.org_id and n.order_id = a.order_id and n.called_at > a.called_at)
             as next_attempt_at,
           (select min(e.occurred_at) from sales.order_events e
             where e.org_id = a.org_id and e.order_id = a.order_id
               and e.trigger in ('confirm', 'cancel') and e.occurred_at > a.called_at)
             as settled_at
    from sales.call_attempts a
    join sales.orders o on o.org_id = a.org_id and o.id = a.order_id
    where a.org_id = ${orgId}
      and a.outcome = 'call_back'
      and a.call_back_at >= ${iso(period.from)}::timestamptz
      and a.call_back_at < ${iso(period.to)}::timestamptz
  `);
  return [...rows];
}

export interface ExpiredOfferRow extends Record<string, unknown> {
  readonly offer_id: string;
  readonly order_id: string;
  readonly order_no: string;
  readonly user_id: string;
  readonly expired_at: Date | string;
}

export async function expiredOffers(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<ExpiredOfferRow[]> {
  const rows = await tx.execute<ExpiredOfferRow>(sql`
    select f.id as offer_id, o.id as order_id, o.order_no, f.user_id,
           coalesce(f.responded_at, f.expires_at) as expired_at
    from sales.order_offers f
    join sales.orders o on o.org_id = f.org_id and o.id = f.order_id
    where f.org_id = ${orgId}
      and f.status = 'expired'
      and f.offered_at >= ${iso(period.from)}::timestamptz
      and f.offered_at < ${iso(period.to)}::timestamptz
  `);
  return [...rows];
}

// --- one person's timeline ---------------------------------------------------------------

export interface TimelineRow extends Record<string, unknown> {
  readonly id: string;
  readonly kind: string;
  readonly at: Date | string;
  readonly order_id: string;
  readonly order_no: string;
  readonly outcome: string | null;
  readonly pieces: number | null;
}

/**
 * Everything one person did at the order desk in the period: the order's events they caused,
 * the orders handed to them, their call attempts, the offers they answered or let lapse, and
 * the returns they recorded. At most `limit` rows, newest first.
 */
export async function timeline(
  tx: Tx,
  orgId: string,
  userId: string,
  period: Period,
  limit: number,
): Promise<TimelineRow[]> {
  const from = iso(period.from);
  const to = iso(period.to);
  const rows = await tx.execute<TimelineRow>(sql`
    select * from (
      select e.id::text as id, 'order.' || e.trigger as kind, e.occurred_at as at,
             o.id as order_id, o.order_no, e.to_status::text as outcome,
             case when e.trigger in ('create', 'confirm')
               then (select sum(l.qty)::int from sales.order_lines l
                     where l.org_id = o.org_id and l.order_id = o.id)
             end as pieces
      from sales.order_events e
      join sales.orders o on o.org_id = e.org_id and o.id = e.order_id
      where e.org_id = ${orgId} and e.actor_user_id = ${userId}
        and e.occurred_at >= ${from}::timestamptz and e.occurred_at < ${to}::timestamptz
      union all
      select 'taken:' || o.id::text, 'order.taken', o.assigned_at, o.id, o.order_no, null, null
      from sales.orders o
      where o.org_id = ${orgId} and o.assigned_to = ${userId}
        and o.assigned_at >= ${from}::timestamptz and o.assigned_at < ${to}::timestamptz
      union all
      select a.id::text, 'order.call_attempt', a.called_at, o.id, o.order_no, a.outcome, null
      from sales.call_attempts a
      join sales.orders o on o.org_id = a.org_id and o.id = a.order_id
      where a.org_id = ${orgId} and a.called_by = ${userId}
        and a.called_at >= ${from}::timestamptz and a.called_at < ${to}::timestamptz
      union all
      select f.id::text, 'order.offer_' || f.status,
             coalesce(f.responded_at, f.expires_at), o.id, o.order_no, null, null
      from sales.order_offers f
      join sales.orders o on o.org_id = f.org_id and o.id = f.order_id
      where f.org_id = ${orgId} and f.user_id = ${userId}
        and f.status in ('accepted', 'declined', 'expired')
        and f.offered_at >= ${from}::timestamptz and f.offered_at < ${to}::timestamptz
      union all
      select r.id::text, 'order.return_recorded', r.created_at, o.id, o.order_no,
             r.reason_code, null
      from sales.order_returns r
      join sales.orders o on o.org_id = r.org_id and o.id = r.order_id
      where r.org_id = ${orgId} and r.recorded_by = ${userId}
        and r.created_at >= ${from}::timestamptz and r.created_at < ${to}::timestamptz
    ) t
    order by at desc, id
    limit ${limit}
  `);
  return [...rows];
}

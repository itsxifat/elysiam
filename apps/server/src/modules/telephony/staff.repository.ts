import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * Telephony's half of staff activity (M57, D-1006): each person's Envo calls, talk time and
 * wrap-ups, the missed calls and late wrap-ups a rule may count, and one person's calls for the
 * timeline. Only gathering. No phone number leaves this file.
 *
 * Whose a call is (D-836): the person on it, `user_id` (who clicked, the extension's person on
 * an outbound call, who answered an inbound one). An inbound call nobody answered has no person;
 * it was the extension's, through `extension_assignments`.
 */

export interface Period {
  readonly from: Date;
  readonly to: Date;
}

const iso = (date: Date) => date.toISOString();

export interface CallCountRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly outbound: number;
  readonly inbound: number;
  readonly answered: number;
  readonly talk_seconds: number;
}

export async function callCounts(tx: Tx, orgId: string, period: Period): Promise<CallCountRow[]> {
  const rows = await tx.execute<CallCountRow>(sql`
    select c.user_id,
           count(*) filter (where c.direction = 'outbound')::int as outbound,
           count(*) filter (where c.direction = 'inbound')::int as inbound,
           count(*) filter (where c.answered)::int as answered,
           coalesce(sum(c.talk_seconds), 0)::int as talk_seconds
    from telephony.calls c
    where c.org_id = ${orgId}
      and c.user_id is not null
      and c.direction in ('inbound', 'outbound')
      and c.occurred_at >= ${iso(period.from)}::timestamptz
      and c.occurred_at < ${iso(period.to)}::timestamptz
    group by 1
  `);
  return [...rows];
}

export interface PersonCountRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly n: number;
}

/** Wrap-ups each person wrote in the period. */
export async function wrapUpCounts(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<PersonCountRow[]> {
  const rows = await tx.execute<PersonCountRow>(sql`
    select c.wrapped_up_by_user_id as user_id, count(*)::int as n
    from telephony.calls c
    where c.org_id = ${orgId}
      and c.wrapped_up_by_user_id is not null
      and c.wrapped_up_at >= ${iso(period.from)}::timestamptz
      and c.wrapped_up_at < ${iso(period.to)}::timestamptz
    group by 1
  `);
  return [...rows];
}

export interface MissedCallRow extends Record<string, unknown> {
  readonly call_id: string;
  readonly user_id: string;
  readonly at: Date | string;
}

/** Inbound calls nobody answered, each with the person whose extension it rang. */
export async function missedCalls(tx: Tx, orgId: string, period: Period): Promise<MissedCallRow[]> {
  const rows = await tx.execute<MissedCallRow>(sql`
    select c.id as call_id, x.user_id, c.occurred_at as at
    from telephony.calls c
    join telephony.extension_assignments x
      on x.org_id = c.org_id and x.connection_id = c.connection_id and x.extension = c.extension
    where c.org_id = ${orgId}
      and c.direction = 'inbound' and not c.answered and c.status in ('ended', 'failed')
      and c.occurred_at >= ${iso(period.from)}::timestamptz
      and c.occurred_at < ${iso(period.to)}::timestamptz
  `);
  return [...rows];
}

/** Missed calls per extension holder, for the counts. */
export async function missedCounts(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<PersonCountRow[]> {
  const rows = await tx.execute<PersonCountRow>(sql`
    select m.user_id, count(*)::int as n from (
      select x.user_id
      from telephony.calls c
      join telephony.extension_assignments x
        on x.org_id = c.org_id and x.connection_id = c.connection_id and x.extension = c.extension
      where c.org_id = ${orgId}
        and c.direction = 'inbound' and not c.answered and c.status in ('ended', 'failed')
        and c.occurred_at >= ${iso(period.from)}::timestamptz
        and c.occurred_at < ${iso(period.to)}::timestamptz
    ) m
    group by 1
  `);
  return [...rows];
}

export interface WrapUpRow extends Record<string, unknown> {
  readonly call_id: string;
  readonly user_id: string;
  readonly ended_at: Date | string;
  readonly wrapped_up_at: Date | string | null;
}

/**
 * Calls that ended in the period and ask for a wrap-up (as `wrapUpsOf`: no error, not internal,
 * a Call button call only once answered), wrapped up later than `minutes` or not at all.
 */
export async function lateWrapUps(
  tx: Tx,
  orgId: string,
  period: Period,
  minutes: number,
): Promise<WrapUpRow[]> {
  const rows = await tx.execute<WrapUpRow>(sql`
    select c.id as call_id, c.user_id, c.ended_at, c.wrapped_up_at
    from telephony.calls c
    where c.org_id = ${orgId}
      and c.user_id is not null
      and c.status = 'ended' and c.error_code is null and c.direction <> 'internal'
      and (c.first_seen <> 'click' or c.answered)
      and c.ended_at >= ${iso(period.from)}::timestamptz
      and c.ended_at < ${iso(period.to)}::timestamptz
      and (c.wrapped_up_at is null
           or c.wrapped_up_at - c.ended_at > make_interval(mins => ${minutes}))
  `);
  return [...rows];
}

/**
 * Of `orderIds`, those with an outbound Envo call linked to them: a verification by phone the
 * desk did not log as an attempt (a wrap-up normally logs one). Lenient on purpose: a call linked
 * after the confirmation still clears the order, so the rule never blames a call it cannot date.
 */
export async function phonedOrders(
  tx: Tx,
  orgId: string,
  orderIds: readonly string[],
): Promise<string[]> {
  if (orderIds.length === 0) return [];
  const rows = await tx.execute<{ order_id: string }>(sql`
    select distinct c.order_id from telephony.calls c
    where c.org_id = ${orgId}
      and c.order_id = any(${sql.param([...orderIds])}::uuid[])
      and c.direction = 'outbound'
  `);
  return rows.map((row) => row.order_id);
}

export interface TimelineRow extends Record<string, unknown> {
  readonly id: string;
  readonly direction: string;
  readonly at: Date | string;
  readonly answered: boolean;
  readonly talk_seconds: number | null;
  readonly order_id: string | null;
  readonly order_no: string | null;
}

export async function timeline(
  tx: Tx,
  orgId: string,
  userId: string,
  period: Period,
  limit: number,
): Promise<TimelineRow[]> {
  const rows = await tx.execute<TimelineRow>(sql`
    select c.id::text as id, c.direction, c.occurred_at as at, c.answered, c.talk_seconds,
           c.order_id, c.order_no
    from telephony.calls c
    where c.org_id = ${orgId} and c.user_id = ${userId}
      and c.direction in ('inbound', 'outbound')
      and c.occurred_at >= ${iso(period.from)}::timestamptz
      and c.occurred_at < ${iso(period.to)}::timestamptz
    order by c.occurred_at desc, c.id
    limit ${limit}
  `);
  return [...rows];
}

import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The inbox's half of staff activity (M57, D-1006): messages each person sent, conversations,
 * notes, how fast they answered, the customers' waits a rule may call too long, and one
 * person's inbox timeline. Only gathering; `detectMistakes` decides.
 *
 * A **wait** is a customer's message whose previous message in the conversation was ours (or
 * none): the start of a stretch of the customer talking. It ends at the first message a person
 * sent after it (`sent_by` set; an automatic message answers nobody). A failed send is no answer.
 */

export interface Period {
  readonly from: Date;
  readonly to: Date;
}

const iso = (date: Date) => date.toISOString();

export interface SentRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly messages: number;
  readonly conversations: number;
}

export async function sentCounts(tx: Tx, orgId: string, period: Period): Promise<SentRow[]> {
  const rows = await tx.execute<SentRow>(sql`
    select m.sent_by as user_id, count(*)::int as messages,
           count(distinct m.conversation_id)::int as conversations
    from inbox.messages m
    where m.org_id = ${orgId}
      and m.direction = 'outbound' and m.sent_by is not null and m.status <> 'failed'
      and m.occurred_at >= ${iso(period.from)}::timestamptz
      and m.occurred_at < ${iso(period.to)}::timestamptz
    group by 1
  `);
  return [...rows];
}

export interface NoteRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly notes: number;
}

export async function noteCounts(tx: Tx, orgId: string, period: Period): Promise<NoteRow[]> {
  const rows = await tx.execute<NoteRow>(sql`
    select n.author_user_id as user_id, count(*)::int as notes
    from inbox.notes n
    where n.org_id = ${orgId}
      and n.created_at >= ${iso(period.from)}::timestamptz
      and n.created_at < ${iso(period.to)}::timestamptz
    group by 1
  `);
  return [...rows];
}

/**
 * How long after the period a reply is still looked for. A wait not answered within it reads as
 * not answered (it was, by then, far past any threshold), which keeps the scan to the period.
 */
export const REPLY_HORIZON_DAYS = 2;

/**
 * The waits that start in the period, with their first reply (a shared fragment).
 *
 * One pass over the period's messages, not a lookup per message: the message before each one is
 * `lag` over the conversation (and, for a conversation's first message in the period, the one
 * message before the period, read once per conversation); the first person's reply after each is
 * a running `min` over the conversation read newest first, a frame that starts at the partition's
 * head so PostgreSQL carries the aggregate forward instead of recomputing it per row. The reply's
 * time and sender travel together as one sortable text (`YYYY-MM-DDTHH:MI:SS.US|user`).
 */
function waits(orgId: string, period: Period) {
  const from = iso(period.from);
  const to = iso(period.to);
  return sql`
    with base as (
      select m.id, m.conversation_id, m.direction, m.sent_by, m.status, m.occurred_at
      from inbox.messages m
      where m.org_id = ${orgId}
        and m.occurred_at >= ${from}::timestamptz
        and m.occurred_at < ${to}::timestamptz + make_interval(days => ${REPLY_HORIZON_DAYS})
    ), prior as (
      select p.id, p.conversation_id, p.direction, p.sent_by, p.status, p.occurred_at
      from (select distinct conversation_id from base) c
      cross join lateral (
        select x.id, x.conversation_id, x.direction, x.sent_by, x.status, x.occurred_at
        from inbox.messages x
        where x.org_id = ${orgId} and x.conversation_id = c.conversation_id
          and x.occurred_at < ${from}::timestamptz
        order by x.occurred_at desc, x.id desc
        limit 1
      ) p
    ), marked as (
      select a.*,
             lag(a.direction) over forward as previous_direction,
             min(case when a.direction = 'outbound' and a.sent_by is not null
                       and a.status <> 'failed'
                  then to_char(a.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
                       || '|' || a.sent_by end)
               over backward as next_reply
      from (select * from base union all select * from prior) a
      window forward as (partition by a.conversation_id order by a.occurred_at, a.id),
             backward as (partition by a.conversation_id order by a.occurred_at desc, a.id desc
                          rows between unbounded preceding and 1 preceding)
    )
    select w.id as message_id, w.conversation_id, w.occurred_at as inbound_at,
           c.assigned_to as holder, c.assigned_at as held_since,
           (split_part(w.next_reply, '|', 1) || 'Z')::timestamptz as replied_at,
           nullif(split_part(w.next_reply, '|', 2), '') as replied_by
    from marked w
    join inbox.conversations c on c.org_id = ${orgId} and c.id = w.conversation_id
    where w.direction = 'inbound'
      and w.occurred_at >= ${from}::timestamptz and w.occurred_at < ${to}::timestamptz
      and coalesce(w.previous_direction, 'outbound') = 'outbound'
  `;
}

export interface ReplyRow {
  readonly user_id: string;
  readonly replies: number;
  readonly median_seconds: number | null;
}

export interface WaitRow {
  readonly message_id: string;
  readonly conversation_id: string;
  readonly inbound_at: Date | string;
  readonly holder: string | null;
  readonly held_since: Date | string | null;
  readonly replied_at: Date | string | null;
  readonly replied_by: string | null;
}

interface SummaryRow extends Record<string, unknown> {
  readonly row_kind: 'reply' | 'wait';
  readonly user_id: string | null;
  readonly replies: number | null;
  readonly median_seconds: number | null;
  readonly message_id: string | null;
  readonly conversation_id: string | null;
  readonly inbound_at: Date | string | null;
  readonly holder: string | null;
  readonly held_since: Date | string | null;
  readonly replied_at: Date | string | null;
  readonly replied_by: string | null;
}

/**
 * The period's waits, read once (M57's budget, check 5): each person's replies with the median of
 * their waits (nearest rank, `percentile_disc`), and the waits longer than `minutes` on the clock
 * or not answered: the only ones a rule could call too long (working-hours time is never more
 * than clock time, so none is lost).
 */
export async function waitSummary(
  tx: Tx,
  orgId: string,
  period: Period,
  minutes: number,
): Promise<{ readonly replies: ReplyRow[]; readonly long: WaitRow[] }> {
  const rows = await tx.execute<SummaryRow>(sql`
    with w as materialized (select * from (${waits(orgId, period)}) x)
    select 'reply' as row_kind, w.replied_by as user_id, count(*)::int as replies,
           percentile_disc(0.5) within group (
             order by floor(extract(epoch from (w.replied_at - w.inbound_at)))::int
           ) as median_seconds,
           null::uuid as message_id, null::uuid as conversation_id,
           null::timestamptz as inbound_at, null::text as holder,
           null::timestamptz as held_since, null::timestamptz as replied_at,
           null::text as replied_by
    from w
    where w.replied_by is not null
    group by w.replied_by
    union all
    select 'wait', null, null, null, w.message_id, w.conversation_id, w.inbound_at, w.holder,
           w.held_since, w.replied_at, w.replied_by
    from w
    where w.replied_at is null
       or w.replied_at - w.inbound_at > make_interval(mins => ${minutes})
  `);
  const replies: ReplyRow[] = [];
  const long: WaitRow[] = [];
  for (const row of rows) {
    if (row.row_kind === 'reply' && row.user_id !== null) {
      replies.push({
        user_id: row.user_id,
        replies: row.replies ?? 0,
        median_seconds: row.median_seconds,
      });
    } else if (row.row_kind === 'wait' && row.message_id !== null && row.conversation_id !== null) {
      long.push({
        message_id: row.message_id,
        conversation_id: row.conversation_id,
        inbound_at: row.inbound_at ?? new Date(0),
        holder: row.holder,
        held_since: row.held_since,
        replied_at: row.replied_at,
        replied_by: row.replied_by,
      });
    }
  }
  return { replies, long };
}

export interface ExpiredOfferRow extends Record<string, unknown> {
  readonly offer_id: string;
  readonly conversation_id: string;
  readonly user_id: string;
  readonly expired_at: Date | string;
}

export async function expiredOffers(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<ExpiredOfferRow[]> {
  const rows = await tx.execute<ExpiredOfferRow>(sql`
    select f.id as offer_id, f.conversation_id, f.user_id,
           coalesce(f.responded_at, f.expires_at) as expired_at
    from inbox.conversation_offers f
    where f.org_id = ${orgId}
      and f.status = 'expired'
      and f.offered_at >= ${iso(period.from)}::timestamptz
      and f.offered_at < ${iso(period.to)}::timestamptz
  `);
  return [...rows];
}

export interface TimelineRow extends Record<string, unknown> {
  readonly id: string;
  readonly kind: string;
  readonly at: Date | string;
  readonly conversation_id: string | null;
}

/** One person's inbox: messages they sent, notes they wrote, offers they answered or let lapse. */
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
      select m.id::text as id, 'inbox.message_sent' as kind, m.occurred_at as at,
             m.conversation_id
      from inbox.messages m
      where m.org_id = ${orgId} and m.sent_by = ${userId} and m.direction = 'outbound'
        and m.status <> 'failed'
        and m.occurred_at >= ${from}::timestamptz and m.occurred_at < ${to}::timestamptz
      union all
      select n.id::text, 'inbox.note', n.created_at, null
      from inbox.notes n
      where n.org_id = ${orgId} and n.author_user_id = ${userId}
        and n.created_at >= ${from}::timestamptz and n.created_at < ${to}::timestamptz
      union all
      select f.id::text, 'inbox.offer_' || f.status, coalesce(f.responded_at, f.expires_at),
             f.conversation_id
      from inbox.conversation_offers f
      where f.org_id = ${orgId} and f.user_id = ${userId}
        and f.status in ('accepted', 'declined', 'expired')
        and f.offered_at >= ${from}::timestamptz and f.offered_at < ${to}::timestamptz
    ) t
    order by at desc, id
    limit ${limit}
  `);
  return [...rows];
}

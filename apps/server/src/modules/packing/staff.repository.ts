import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * Packing's half of staff activity (M57, D-1006): the packing and return stations, lots, the
 * courier handover and the label printers, by the person on each row; the scans and sessions a
 * mistake rule may read; one person's hub timeline. Only gathering.
 *
 * A packing session's `kind` is `pack` (an order packed at a station) or `return` (an order's
 * pieces checked back in at the return station, M51).
 */

export interface Period {
  readonly from: Date;
  readonly to: Date;
}

const iso = (date: Date) => date.toISOString();

export interface SessionCountRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly packed: number;
  readonly returns_closed: number;
  readonly median_pack_seconds: number | null;
}

export async function sessionCounts(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<SessionCountRow[]> {
  const rows = await tx.execute<SessionCountRow>(sql`
    select s.completed_by as user_id,
           count(*) filter (where s.kind = 'pack')::int as packed,
           count(*) filter (where s.kind = 'return')::int as returns_closed,
           percentile_disc(0.5) within group (
             order by floor(extract(epoch from (s.completed_at - s.started_at)))::int
           ) filter (where s.kind = 'pack') as median_pack_seconds
    from packing.sessions s
    where s.org_id = ${orgId}
      and s.status = 'completed' and s.completed_by is not null
      and s.completed_at >= ${iso(period.from)}::timestamptz
      and s.completed_at < ${iso(period.to)}::timestamptz
    group by 1
  `);
  return [...rows];
}

export interface ScanCountRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly pieces_packed: number;
  readonly pieces_returned: number;
  readonly wrong: number;
}

export async function scanCounts(tx: Tx, orgId: string, period: Period): Promise<ScanCountRow[]> {
  const rows = await tx.execute<ScanCountRow>(sql`
    select c.scanned_by as user_id,
           greatest(
             count(*) filter (where s.kind = 'pack' and c.outcome = 'accepted')
             - count(*) filter (where s.kind = 'pack' and c.outcome = 'removed'),
             0
           )::int as pieces_packed,
           greatest(
             count(*) filter (where s.kind = 'return' and c.outcome = 'accepted')
             - count(*) filter (where s.kind = 'return' and c.outcome = 'removed'),
             0
           )::int as pieces_returned,
           count(*) filter (where c.outcome in ('wrong_item', 'wrong_variant', 'over'))::int
             as wrong
    from packing.scans c
    join packing.sessions s on s.org_id = c.org_id and s.id = c.session_id
    where c.org_id = ${orgId}
      and c.scanned_at >= ${iso(period.from)}::timestamptz
      and c.scanned_at < ${iso(period.to)}::timestamptz
    group by 1
  `);
  return [...rows];
}

export interface PersonCountRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly a: number;
  readonly b: number;
}

/** Lots closed (a) and handover scans (b). */
export async function lotAndHandoverCounts(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<PersonCountRow[]> {
  const rows = await tx.execute<PersonCountRow>(sql`
    select user_id, sum(a)::int as a, sum(b)::int as b from (
      select l.closed_by as user_id, count(*) as a, 0 as b
      from packing.lot_closures l
      where l.org_id = ${orgId}
        and l.closed_at >= ${iso(period.from)}::timestamptz
        and l.closed_at < ${iso(period.to)}::timestamptz
      group by 1
      union all
      select h.scanned_by, 0, count(*)
      from packing.handover_scans h
      where h.org_id = ${orgId}
        and h.scanned_at >= ${iso(period.from)}::timestamptz
        and h.scanned_at < ${iso(period.to)}::timestamptz
      group by 1
    ) t
    group by 1
  `);
  return [...rows];
}

/** Labels printed (a) and reprints asked for (b), by who asked. */
export async function printCounts(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<PersonCountRow[]> {
  const rows = await tx.execute<PersonCountRow>(sql`
    select p.requested_by as user_id,
           count(*) filter (where p.document = 'label' and p.state = 'printed')::int as a,
           count(*) filter (where p.source = 'reprint')::int as b
    from packing.print_jobs p
    where p.org_id = ${orgId}
      and p.requested_by is not null
      and p.created_at >= ${iso(period.from)}::timestamptz
      and p.created_at < ${iso(period.to)}::timestamptz
    group by 1
  `);
  return [...rows];
}

export interface WrongScanRow extends Record<string, unknown> {
  readonly scan_id: string;
  readonly session_id: string;
  readonly order_id: string;
  readonly order_no: string;
  readonly scanned_by: string;
  readonly at: Date | string;
  readonly outcome: 'wrong_item' | 'wrong_variant' | 'over';
}

export async function wrongScans(tx: Tx, orgId: string, period: Period): Promise<WrongScanRow[]> {
  const rows = await tx.execute<WrongScanRow>(sql`
    select c.id as scan_id, s.id as session_id, s.order_id, s.order_no, c.scanned_by,
           c.scanned_at as at, c.outcome
    from packing.scans c
    join packing.sessions s on s.org_id = c.org_id and s.id = c.session_id
    where c.org_id = ${orgId}
      and c.outcome in ('wrong_item', 'wrong_variant', 'over')
      and c.scanned_at >= ${iso(period.from)}::timestamptz
      and c.scanned_at < ${iso(period.to)}::timestamptz
  `);
  return [...rows];
}

export interface PackerRow extends Record<string, unknown> {
  readonly order_id: string;
  readonly session_id: string;
  readonly completed_by: string;
  readonly completed_at: Date | string;
}

/** The completed packing sessions of these orders, whenever they were. */
export async function packersOf(
  tx: Tx,
  orgId: string,
  orderIds: readonly string[],
): Promise<PackerRow[]> {
  if (orderIds.length === 0) return [];
  const rows = await tx.execute<PackerRow>(sql`
    select s.order_id, s.id as session_id, s.completed_by, s.completed_at
    from packing.sessions s
    where s.org_id = ${orgId}
      and s.kind = 'pack' and s.status = 'completed' and s.completed_by is not null
      and s.order_id = any(${sql.param([...orderIds])}::uuid[])
  `);
  return [...rows];
}

export interface NoVideoRow extends Record<string, unknown> {
  readonly session_id: string;
  readonly order_id: string;
  readonly order_no: string;
  readonly completed_by: string;
  readonly completed_at: Date | string;
}

/**
 * Packings completed in the period that needed a video and have none, counted only an hour after
 * completing: a video uploads after the packing, and a slow connection is not a mistake.
 */
export async function packedWithoutVideo(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<NoVideoRow[]> {
  const rows = await tx.execute<NoVideoRow>(sql`
    select s.id as session_id, s.order_id, s.order_no, s.completed_by, s.completed_at
    from packing.sessions s
    where s.org_id = ${orgId}
      and s.kind = 'pack' and s.status = 'completed' and s.video_required
      and s.completed_by is not null
      and s.completed_at >= ${iso(period.from)}::timestamptz
      and s.completed_at < ${iso(period.to)}::timestamptz
      and s.completed_at < now() - interval '1 hour'
      and not exists (
        select 1 from packing.videos v
        where v.org_id = s.org_id and v.session_id = s.id and v.deleted_at is null
      )
  `);
  return [...rows];
}

export interface TimelineRow extends Record<string, unknown> {
  readonly id: string;
  readonly kind: string;
  readonly at: Date | string;
  readonly order_id: string | null;
  readonly order_no: string | null;
  readonly session_id: string | null;
  readonly pieces: number | null;
  readonly lot_no: number | null;
}

/**
 * One person at the hub: packings and returns they completed (with pieces), refused scans,
 * lots closed, handover scans and reprints.
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
      select s.id::text as id,
             case s.kind when 'pack' then 'packing.completed' else 'packing.return_closed' end
               as kind,
             s.completed_at as at, s.order_id, s.order_no, s.id as session_id,
             (select count(*)::int from packing.scans c
               where c.org_id = s.org_id and c.session_id = s.id and c.outcome = 'accepted')
               as pieces,
             null::int as lot_no
      from packing.sessions s
      where s.org_id = ${orgId} and s.completed_by = ${userId} and s.status = 'completed'
        and s.completed_at >= ${from}::timestamptz and s.completed_at < ${to}::timestamptz
      union all
      select c.id::text, 'packing.wrong_scan', c.scanned_at, s.order_id, s.order_no, s.id,
             null, null
      from packing.scans c
      join packing.sessions s on s.org_id = c.org_id and s.id = c.session_id
      where c.org_id = ${orgId} and c.scanned_by = ${userId}
        and c.outcome in ('wrong_item', 'wrong_variant', 'over')
        and c.scanned_at >= ${from}::timestamptz and c.scanned_at < ${to}::timestamptz
      union all
      select l.session_id::text || ':' || l.lot_no::text, 'packing.lot_closed', l.closed_at, s.order_id, s.order_no, s.id,
             null, l.lot_no
      from packing.lot_closures l
      join packing.sessions s on s.org_id = l.org_id and s.id = l.session_id
      where l.org_id = ${orgId} and l.closed_by = ${userId}
        and l.closed_at >= ${from}::timestamptz and l.closed_at < ${to}::timestamptz
      union all
      select h.order_id::text || ':' || h.lot_no::text || ':' || h.scanned_at::text,
             'packing.handover_scan', h.scanned_at, h.order_id, null, null, null,
             h.lot_no
      from packing.handover_scans h
      where h.org_id = ${orgId} and h.scanned_by = ${userId}
        and h.scanned_at >= ${from}::timestamptz and h.scanned_at < ${to}::timestamptz
      union all
      select p.id::text, 'packing.reprint', p.created_at, p.order_id, p.order_no, null, null,
             p.lot_no
      from packing.print_jobs p
      where p.org_id = ${orgId} and p.requested_by = ${userId} and p.source = 'reprint'
        and p.created_at >= ${from}::timestamptz and p.created_at < ${to}::timestamptz
    ) t
    order by at desc, id
    limit ${limit}
  `);
  return [...rows];
}

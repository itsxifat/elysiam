import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The courier module's half of staff activity (M57, D-1006): returned parcels each person
 * received (at the return station, M51, or the counter), with their pieces. Only gathering.
 */

export interface Period {
  readonly from: Date;
  readonly to: Date;
}

const iso = (date: Date) => date.toISOString();

export interface ReceiptCountRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly received: number;
  readonly pieces: number;
  readonly damaged: number;
}

export async function receiptCounts(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<ReceiptCountRow[]> {
  const rows = await tx.execute<ReceiptCountRow>(sql`
    select r.received_by as user_id, count(*)::int as received,
           coalesce(sum(l.sellable + l.damaged), 0)::int as pieces,
           coalesce(sum(l.damaged), 0)::int as damaged
    from courier.return_receipts r
    left join lateral (
      select sum(x.sellable_qty) as sellable, sum(x.damaged_qty) as damaged
      from courier.return_receipt_lines x
      where x.org_id = r.org_id and x.receipt_id = r.id
    ) l on true
    where r.org_id = ${orgId}
      and r.received_by is not null
      and r.received_at >= ${iso(period.from)}::timestamptz
      and r.received_at < ${iso(period.to)}::timestamptz
    group by 1
  `);
  return [...rows];
}

export interface ReceiptRow extends Record<string, unknown> {
  readonly id: string;
  readonly at: Date | string;
  readonly order_id: string;
  readonly pieces: number;
  readonly damaged: number;
}

export async function timeline(
  tx: Tx,
  orgId: string,
  userId: string,
  period: Period,
  limit: number,
): Promise<ReceiptRow[]> {
  const rows = await tx.execute<ReceiptRow>(sql`
    select r.id::text as id, r.received_at as at, r.order_id,
           coalesce((select sum(x.sellable_qty + x.damaged_qty) from courier.return_receipt_lines x
                     where x.org_id = r.org_id and x.receipt_id = r.id), 0)::int as pieces,
           coalesce((select sum(x.damaged_qty) from courier.return_receipt_lines x
                     where x.org_id = r.org_id and x.receipt_id = r.id), 0)::int as damaged
    from courier.return_receipts r
    where r.org_id = ${orgId} and r.received_by = ${userId}
      and r.received_at >= ${iso(period.from)}::timestamptz
      and r.received_at < ${iso(period.to)}::timestamptz
    order by r.received_at desc, r.id
    limit ${limit}
  `);
  return [...rows];
}

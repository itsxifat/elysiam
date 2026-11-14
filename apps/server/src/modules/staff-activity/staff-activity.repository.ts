import type { Tx } from '@elysium/db';
import {
  DEFAULT_STAFF_ACTIVITY_SETTINGS,
  type MistakeReview,
  type StaffActivitySettings,
} from '@elysium/domain/staff-activity';
import { sql } from 'drizzle-orm';

/**
 * The staff-activity module's own SQL (M57): a brand's settings and the reviews of mistakes.
 * Everything else it shows arrives through the other modules' APIs (D-1006).
 */

interface SettingsRow extends Record<string, unknown> {
  readonly call_back_grace_minutes: number;
  readonly first_reply_minutes: number;
  readonly unanswered_minutes: number;
  readonly wrap_up_minutes: number;
  readonly workday_start_minute: number;
  readonly workday_end_minute: number;
  readonly require_verification_call: boolean;
  readonly show_colleague_names: boolean;
  readonly mistakes_reduce_bonuses: boolean;
}

export async function settingsOf(tx: Tx, orgId: string): Promise<StaffActivitySettings | null> {
  const [row] = await tx.execute<SettingsRow>(sql`
    select call_back_grace_minutes, first_reply_minutes, unanswered_minutes, wrap_up_minutes,
           workday_start_minute, workday_end_minute, require_verification_call,
           show_colleague_names, mistakes_reduce_bonuses
    from staff_activity.settings where org_id = ${orgId}
  `);
  if (row === undefined) return null;
  return {
    callBackGraceMinutes: row.call_back_grace_minutes,
    firstReplyMinutes: row.first_reply_minutes,
    unansweredMinutes: row.unanswered_minutes,
    wrapUpMinutes: row.wrap_up_minutes,
    workdayStartMinute: row.workday_start_minute,
    workdayEndMinute: row.workday_end_minute,
    requireVerificationCall: row.require_verification_call,
    showColleagueNames: row.show_colleague_names,
    mistakesReduceBonuses: row.mistakes_reduce_bonuses,
  };
}

export async function settingsOrDefaults(tx: Tx, orgId: string): Promise<StaffActivitySettings> {
  return (await settingsOf(tx, orgId)) ?? DEFAULT_STAFF_ACTIVITY_SETTINGS;
}

export async function saveSettings(
  tx: Tx,
  orgId: string,
  settings: StaffActivitySettings,
  updatedBy: string,
): Promise<void> {
  await tx.execute(sql`
    insert into staff_activity.settings (
      org_id, call_back_grace_minutes, first_reply_minutes, unanswered_minutes, wrap_up_minutes,
      workday_start_minute, workday_end_minute, require_verification_call, show_colleague_names,
      mistakes_reduce_bonuses, updated_by
    ) values (
      ${orgId}, ${settings.callBackGraceMinutes}, ${settings.firstReplyMinutes},
      ${settings.unansweredMinutes}, ${settings.wrapUpMinutes}, ${settings.workdayStartMinute},
      ${settings.workdayEndMinute}, ${settings.requireVerificationCall},
      ${settings.showColleagueNames}, ${settings.mistakesReduceBonuses}, ${updatedBy}
    )
    on conflict (org_id) do update set
      call_back_grace_minutes = excluded.call_back_grace_minutes,
      first_reply_minutes = excluded.first_reply_minutes,
      unanswered_minutes = excluded.unanswered_minutes,
      wrap_up_minutes = excluded.wrap_up_minutes,
      workday_start_minute = excluded.workday_start_minute,
      workday_end_minute = excluded.workday_end_minute,
      require_verification_call = excluded.require_verification_call,
      show_colleague_names = excluded.show_colleague_names,
      mistakes_reduce_bonuses = excluded.mistakes_reduce_bonuses,
      updated_by = excluded.updated_by,
      updated_at = now()
  `);
}

interface ReviewRow extends Record<string, unknown> {
  readonly mistake_key: string;
  readonly kind: string;
  readonly user_id: string;
  readonly status: 'confirmed' | 'dismissed';
  readonly note: string | null;
  readonly reviewed_by: string;
  readonly reviewed_at: Date | string;
}

export interface StoredReview extends MistakeReview {
  readonly key: string;
  readonly kind: string;
  readonly userId: string;
}

function reviewOf(row: ReviewRow): StoredReview {
  return {
    key: row.mistake_key,
    kind: row.kind,
    userId: row.user_id,
    status: row.status,
    note: row.note,
    reviewedBy: row.reviewed_by,
    reviewedAt: new Date(row.reviewed_at),
  };
}

/** The reviews of these mistakes, by key. */
export async function reviewsOf(
  tx: Tx,
  orgId: string,
  keys: readonly string[],
): Promise<Map<string, StoredReview>> {
  if (keys.length === 0) return new Map();
  const rows = await tx.execute<ReviewRow>(sql`
    select mistake_key, kind, user_id, status, note, reviewed_by, reviewed_at
    from staff_activity.mistake_reviews
    where org_id = ${orgId} and mistake_key = any(${sql.param([...keys])}::text[])
  `);
  return new Map(rows.map((row) => [row.mistake_key, reviewOf(row)]));
}

export async function reviewFor(
  tx: Tx,
  orgId: string,
  key: string,
): Promise<StoredReview | undefined> {
  const [row] = await tx.execute<ReviewRow>(sql`
    select mistake_key, kind, user_id, status, note, reviewed_by, reviewed_at
    from staff_activity.mistake_reviews
    where org_id = ${orgId} and mistake_key = ${key}
    for update
  `);
  return row === undefined ? undefined : reviewOf(row);
}

export async function saveReview(tx: Tx, orgId: string, review: StoredReview): Promise<void> {
  await tx.execute(sql`
    insert into staff_activity.mistake_reviews
      (org_id, mistake_key, kind, user_id, status, note, reviewed_by, reviewed_at)
    values (
      ${orgId}, ${review.key}, ${review.kind}, ${review.userId}, ${review.status}, ${review.note},
      ${review.reviewedBy}, ${review.reviewedAt.toISOString()}::timestamptz
    )
    on conflict (org_id, mistake_key) do update set
      kind = excluded.kind,
      user_id = excluded.user_id,
      status = excluded.status,
      note = excluded.note,
      reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at,
      updated_at = now()
  `);
}

export async function transactionNow(tx: Tx): Promise<Date> {
  const [row] = await tx.execute<{ now: Date | string }>(sql`select now() as now`);
  if (row === undefined) throw new Error('the database did not say what time it is');
  return new Date(row.now);
}

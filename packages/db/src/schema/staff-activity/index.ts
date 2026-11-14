import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { timestamps } from '../columns.js';
import { users } from '../iam/index.js';
import { organizations } from '../org/index.js';

/**
 * Staff activity (M57, D-1000 to D-1006): each person's figures, timeline and mistakes.
 *
 * Almost nothing is stored here. The figures and the mistakes are computed on read from what the
 * owning modules already record, through their `*.api.ts` ports (D-1002, D-1006); presence history
 * is the team module's (`team.presence_spans`). What is this module's own is a brand's settings
 * and an org admin's review of a mistake.
 *
 * Tenant tables with the full treatment (invariant 4): `org_id NOT NULL`, RLS ENABLE and FORCE
 * (migration `*_m57_staff_activity_policies`).
 */
export const staffActivity = pgSchema('staff_activity');

/** A brand's thresholds and switches (D-1000, D-1001, D-1004); no row reads as the defaults. */
export const staffActivitySettings = staffActivity.table(
  'settings',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** A call-back time passed by this much with no new attempt is a missed call-back. */
    callBackGraceMinutes: integer('call_back_grace_minutes').notNull().default(30),
    /** A first reply later than this after the customer's message is slow. */
    firstReplyMinutes: integer('first_reply_minutes').notNull().default(15),
    /** A customer's message unanswered this long is a conversation left unanswered. */
    unansweredMinutes: integer('unanswered_minutes').notNull().default(60),
    /** An answered call with no wrap-up after this long. */
    wrapUpMinutes: integer('wrap_up_minutes').notNull().default(10),
    /** Working hours, minutes after Asia/Dhaka midnight; the inbox rules pause outside them. */
    workdayStartMinute: integer('workday_start_minute').notNull().default(540),
    workdayEndMinute: integer('workday_end_minute').notNull().default(1320),
    /** A confirmation with no call attempt at all is a mistake. */
    requireVerificationCall: boolean('require_verification_call').notNull().default(true),
    /** Staff see their colleagues' names in the comparison table, or "Colleague n". */
    showColleagueNames: boolean('show_colleague_names').notNull().default(true),
    /** A bonus rule's `mistakes` block applies (D-1001). Off: review only. */
    mistakesReduceBonuses: boolean('mistakes_reduce_bonuses').notNull().default(false),
    updatedBy: text('updated_by').notNull(),
    ...timestamps,
  },
  (table) => [
    check(
      'settings_minutes',
      sql`${table.callBackGraceMinutes} between 1 and 1440
        and ${table.firstReplyMinutes} between 1 and 1440
        and ${table.unansweredMinutes} between 1 and 1440
        and ${table.wrapUpMinutes} between 1 and 1440`,
    ),
    check(
      'settings_workday',
      sql`${table.workdayStartMinute} between 0 and 1439
        and ${table.workdayEndMinute} between 1 and 1440
        and ${table.workdayStartMinute} < ${table.workdayEndMinute}`,
    ),
  ],
);

/**
 * An org admin's word on one detected mistake (D-1002): it was one, or it was not. The mistake
 * itself is computed on read and named by its stable key (`kind:source id`); a review whose
 * mistake no longer comes up (a rule fixed, a source corrected) is kept and simply matches
 * nothing. Changed by a later review, never deleted; each change audited.
 */
export const staffMistakeReviews = staffActivity.table(
  'mistake_reviews',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    mistakeKey: text('mistake_key').notNull(),
    kind: text('kind').notNull(),
    /** The person the mistake was put on when it was reviewed. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text('status').notNull(),
    note: text('note'),
    reviewedBy: text('reviewed_by').notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ name: 'mistake_reviews_pkey', columns: [table.orgId, table.mistakeKey] }),
    index('mistake_reviews_org_idx').on(table.orgId),
    index('mistake_reviews_org_user_idx').on(table.orgId, table.userId),
    check('mistake_reviews_status', sql`${table.status} in ('confirmed', 'dismissed')`),
    check('mistake_reviews_note', sql`${table.note} is null or char_length(${table.note}) <= 500`),
    check('mistake_reviews_key', sql`char_length(${table.mistakeKey}) between 3 and 200`),
  ],
);

import { z } from 'zod';

/**
 * Staff activity (M57, D-1000 to D-1006): the periods, filters, a mistake's review and a brand's
 * settings, as the console sends them. Dates are Asia/Dhaka calendar dates (invariant 8); a
 * period is `from` to `to`, both included.
 */

export const STAFF_ACTIVITY_DESKS = ['orders', 'inbox', 'calls', 'packing', 'returns'] as const;
export type StaffActivityDesk = (typeof STAFF_ACTIVITY_DESKS)[number];

export const MISTAKE_REVIEW_STATUSES = ['confirmed', 'dismissed'] as const;
export type MistakeReviewStatusInput = (typeof MISTAKE_REVIEW_STATUSES)[number];

/** The longest period the team table, a person's page and the mistakes read at once. */
export const STAFF_ACTIVITY_MAX_DAYS = 92;
/** The longest period one timeline reads at once. */
export const STAFF_TIMELINE_MAX_DAYS = 7;
/** At most this many timeline lines in one answer. */
export const STAFF_TIMELINE_LIMIT = 1500;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date: YYYY-MM-DD.');

const dayCount = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

function period(maxDays: number) {
  return z
    .object({ from: isoDate, to: isoDate })
    .refine((value) => value.from <= value.to, {
      message: 'The period ends before it starts.',
      path: ['to'],
    })
    .refine((value) => dayCount(value.from, value.to) <= maxDays, {
      message: `At most ${String(maxDays)} days at once.`,
      path: ['to'],
    });
}

export const staffActivityPeriodSchema = period(STAFF_ACTIVITY_MAX_DAYS);

export const staffTeamQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    desk: z.enum(STAFF_ACTIVITY_DESKS).optional(),
  })
  .and(staffActivityPeriodSchema);
export type StaffTeamQuery = z.infer<typeof staffTeamQuerySchema>;

export const staffTimelineQuerySchema = period(STAFF_TIMELINE_MAX_DAYS);
export type StaffTimelineQuery = z.infer<typeof staffTimelineQuerySchema>;

export const staffMistakesQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    userId: z.string().min(1).max(64).optional(),
    kind: z
      .string()
      .regex(/^[a-z_]{3,40}$/, 'A mistake kind.')
      .optional(),
    status: z.enum(['unreviewed', 'confirmed', 'dismissed']).optional(),
  })
  .and(staffActivityPeriodSchema);
export type StaffMistakesQuery = z.infer<typeof staffMistakesQuerySchema>;

export const mistakeReviewInputSchema = z.object({
  status: z.enum(MISTAKE_REVIEW_STATUSES),
  note: z.string().trim().max(500, 'At most 500 characters.').nullable().optional(),
});
export type MistakeReviewInput = z.infer<typeof mistakeReviewInputSchema>;

const minutes = z.number().int().min(1, 'At least a minute.').max(1440, 'At most a day.');

export const staffActivitySettingsInputSchema = z
  .object({
    callBackGraceMinutes: minutes,
    firstReplyMinutes: minutes,
    unansweredMinutes: minutes,
    wrapUpMinutes: minutes,
    workdayStartMinute: z.number().int().min(0).max(1439),
    workdayEndMinute: z.number().int().min(1).max(1440),
    requireVerificationCall: z.boolean(),
    showColleagueNames: z.boolean(),
    mistakesReduceBonuses: z.boolean(),
  })
  .refine((value) => value.workdayStartMinute < value.workdayEndMinute, {
    message: 'The working day ends before it starts.',
    path: ['workdayEndMinute'],
  })
  .refine((value) => value.firstReplyMinutes < value.unansweredMinutes, {
    message: 'Unanswered must be longer than a slow first reply.',
    path: ['unansweredMinutes'],
  });
export type StaffActivitySettingsInput = z.infer<typeof staffActivitySettingsInputSchema>;

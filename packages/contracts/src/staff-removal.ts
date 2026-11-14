import { z } from 'zod';

/**
 * Permanently removing a deactivated staff sign-in (D-1023): three warnings, each shown for
 * five seconds, then the person's name typed exactly. A subpath of its own, not in the barrel,
 * so the console's first download does not carry a schema only the server parses (§24 budget).
 */
export const STAFF_REMOVAL_WARNING_SECONDS = 5;
export const STAFF_REMOVAL_WARNING_COUNT = 3;

export const removeStaffSchema = z.strictObject({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  confirmationName: z.string().trim().min(1).max(200),
  warningsAcknowledged: z.literal(STAFF_REMOVAL_WARNING_COUNT),
});
export type RemoveStaff = z.infer<typeof removeStaffSchema>;

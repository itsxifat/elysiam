import { z } from 'zod';

/**
 * D-1025: pages a person saw not come out of the printer, put back to Ready for label. A subpath
 * of its own, out of the barrel, so the console's first download does not carry a schema only
 * the server parses (§24 budget).
 */
export const MAX_NOT_PRINTED = 100;

export const notPrintedSchema = z.strictObject({
  jobIds: z.array(z.string().uuid()).min(1).max(MAX_NOT_PRINTED),
});
export type NotPrintedInput = z.infer<typeof notPrintedSchema>;

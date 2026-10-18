// Structured closing check of an investigator (see worker-loop.ts): the model
// reports whether its own readings showed a repairable defect and in which
// specialist area. The loop uses the answer only to send the investigator back
// to delegate; it never decides the diagnosis.
import { z } from 'zod';
import { jsonSchemaOf } from './planner.js';

export const ClosingCheckSchema = z
  .object({
    defectFound: z.boolean(),
    area: z.enum(['cache', 'database', 'routing', 'none']),
    reason: z.string().max(500),
  })
  .strict();

export const CLOSING_CHECK_FORMAT = Object.freeze({
  name: 'closing_check',
  schema: jsonSchemaOf(ClosingCheckSchema),
});

export function parseClosingCheck(
  reply: string,
): z.infer<typeof ClosingCheckSchema> | null {
  try {
    const parsed = ClosingCheckSchema.safeParse(JSON.parse(reply));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

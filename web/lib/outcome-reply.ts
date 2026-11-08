// The compact Zod API, as live-refresh.tsx uses it: the full one would ship every page its schema and locale machinery.
import * as z from "zod/mini";
import type { Outcome } from "./outcome";

/** A refusal as the site's routes send it (`Failure` in outcome.ts). */
const failureSchema = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.optional(z.string()),
  operationId: z.optional(z.string()),
  issues: z.optional(
    z.array(z.object({ path: z.string(), message: z.string() })),
  ),
});

/** Pure: `body`, a site route's JSON reply, as an Outcome whose value `value` accepts; undefined for anything else, which
 * the page reports instead of drawing. */
export function outcomeReply<T>(
  body: unknown,
  value: z.ZodMiniType<T>,
): Outcome<T> | undefined {
  const reply = z
    .union([
      z.object({ ok: z.literal(true), value }),
      z.object({ ok: z.literal(false), failure: failureSchema }),
    ])
    .safeParse(body);
  return reply.success ? (reply.data as Outcome<T>) : undefined;
}

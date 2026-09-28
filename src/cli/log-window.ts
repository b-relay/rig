import { z } from "zod";
import { RigError } from "../domain/errors";
import { terminalText } from "./terminal-text";

const UNIT_MS = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;
/** One or more `<count><unit>` parts such as `90s`, `15m`, `1h30m`, `2d` or `1w`. */
const duration = z.string().regex(/^(\d+[smhdw])+$/);
/** An ISO 8601 date and time with seconds and a zone (`Z` or an offset), so the instant never depends on this Mac's zone. */
const instant = z.iso.datetime({ offset: true });

/** Resolves the `--since` and `--until` a user typed into ISO instants: a duration counts back from `now`, an ISO time keeps
 * its instant. Absent flags stay absent. Fails USAGE for input that is neither, or for a `since` later than `until`. */
export function logTimeWindow(
  input: { readonly since?: string; readonly until?: string },
  now: Date,
): { since?: string; until?: string } {
  const since =
    input.since === undefined
      ? undefined
      : resolveTime(input.since, "--since", now);
  const until =
    input.until === undefined
      ? undefined
      : resolveTime(input.until, "--until", now);
  if (since && until && Date.parse(since) > Date.parse(until))
    throw new RigError(
      "USAGE",
      `--since (${since}) is later than --until (${until}).`,
      "Pass a --since at or before --until.",
    );
  return {
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
  };
}

function resolveTime(value: string, flag: string, now: Date): string {
  let at: number | undefined;
  if (duration.safeParse(value).success) at = now.getTime() - durationMs(value);
  else if (instant.safeParse(value).success) at = Date.parse(value);
  // Date only represents ±8.64e15 ms; anything further is not a time Rig can compare.
  if (at === undefined || !Number.isFinite(at) || Math.abs(at) > 8.64e15)
    throw new RigError(
      "USAGE",
      `${flag} '${terminalText(value)}' is neither a duration nor an ISO time.`,
      "Use a duration back from now such as 90s, 15m, 1h, 2d or 1w (parts combine, as in 1h30m), or an ISO time with a zone such as 2026-09-28T03:00:00Z or 2026-09-28T05:00:00+02:00.",
      { flag },
    );
  return new Date(at).toISOString();
}

function durationMs(value: string): number {
  let total = 0;
  for (const [, count, unit] of value.matchAll(/(\d+)([smhdw])/g))
    total += Number(count) * UNIT_MS[unit as keyof typeof UNIT_MS];
  return total;
}

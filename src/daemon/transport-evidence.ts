import type { DiagnosticEntry } from "../diagnostics/types";

/** How one request ended that the control plane refused or failed to serve. Holds nothing the request carried: its route
 * is a fixed category, never its URL. */
export interface TransportOutcome {
  route: "health" | "command" | "config" | "env" | "other";
  status: number;
  code: string;
  durationMs: number;
  /** A failure's class of error, never its message, which may quote what it was handling. */
  cause?: string;
}
/** At most one entry per route, status and code in this long, so repeated refusals cannot grow the diagnostic log with
 * how often they arrive. */
const EVIDENCE_WINDOW_MS = 60_000;

/** The control plane's report: writes each kind of outcome through `record` at once, then at most once per window, an
 * entry whose `repeated` counts those since the last one (the latest stands for them). A count still open when rigd stops
 * is lost; the entry before it stays. */
export function transportEvidence(
  record: (entry: DiagnosticEntry) => void,
  windowMs = EVIDENCE_WINDOW_MS,
): (outcome: TransportOutcome) => void {
  const windows = new Map<
    string,
    { latest: TransportOutcome; count: number }
  >();
  const open = (key: string, outcome: TransportOutcome) => {
    windows.set(key, { latest: outcome, count: 0 });
    setTimeout(() => {
      const { latest, count } = windows.get(key)!;
      windows.delete(key);
      if (count === 0) return;
      record(entryOf(latest, count));
      open(key, latest);
    }, windowMs).unref();
  };
  return (outcome) => {
    const key = `${outcome.route} ${outcome.status} ${outcome.code}`;
    const current = windows.get(key);
    if (current) {
      current.latest = outcome;
      current.count += 1;
      return;
    }
    record(entryOf(outcome));
    open(key, outcome);
  };
}
function entryOf(outcome: TransportOutcome, repeated = 0): DiagnosticEntry {
  const failed = outcome.status >= 500;
  return {
    event: failed ? "transport.failed" : "transport.refused",
    level: failed ? "error" : "warn",
    route: outcome.route,
    status: String(outcome.status),
    code: outcome.code,
    durationMs: String(Math.round(outcome.durationMs)),
    ...(outcome.cause ? { cause: outcome.cause } : {}),
    ...(repeated ? { repeated: String(repeated) } : {}),
  };
}

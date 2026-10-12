"use client";

import { useEffect, useState } from "react";
import type { Outcome } from "@/lib/outcome";
import type { ChartReport } from "@/lib/usage";

/** The query a Monitor page polls: one Project's, or with `host` the whole Host's, CPU and memory over `range`. */
export interface UsageQuery {
  readonly project?: string;
  readonly host?: true;
  readonly range: ChartReport["range"];
}

/** The newest report of `query`, starting from the one the page was rendered with and read again after every sample
 * (`/usage`). Polling pauses while the tab is hidden. A failed read keeps the last report and says why, until a read
 * succeeds again. */
export function useUsage(
  initial: ChartReport,
  query: UsageQuery,
): { report: ChartReport; failure?: string } {
  const [report, setReport] = useState(initial);
  const [failure, setFailure] = useState<string | undefined>();
  const q = JSON.stringify(query);
  useEffect(() => setReport(initial), [initial]);
  useEffect(() => {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delay = () => Math.max(report.sampledEvery, 1) * 1000;
    const poll = async () => {
      if (document.visibilityState === "visible") {
        try {
          const response = await fetch(`/usage?q=${encodeURIComponent(q)}`, {
            signal: stop.signal,
            cache: "no-store",
          });
          const outcome = (await response.json()) as Outcome<ChartReport>;
          if (outcome.ok) {
            setReport(outcome.value);
            setFailure(undefined);
          } else setFailure(outcome.failure.message);
        } catch (error) {
          if (stop.signal.aborted) return;
          setFailure(
            error instanceof Error ? error.message : "The dashboard lost rigd.",
          );
        }
      }
      if (!stop.signal.aborted) timer = setTimeout(poll, delay());
    };
    timer = setTimeout(poll, delay());
    return () => {
      stop.abort();
      clearTimeout(timer);
    };
    // The poll restarts only when what it asks for changes, not with every report it receives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  return failure === undefined ? { report } : { report, failure };
}

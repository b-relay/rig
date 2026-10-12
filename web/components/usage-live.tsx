"use client";

import { useEffect, useRef, useState } from "react";
import { describeFailure, type Failure, type Outcome } from "@/lib/outcome";
import type { ChartReport } from "@/lib/usage";

/** The query a Monitor page polls: the whole Host's CPU and memory, or one Project's with only `target`'s Components
 * (none for `all`), over `range`. */
export type UsageQuery =
  | { readonly host: true; readonly range: ChartReport["range"] }
  | {
      readonly project: string;
      readonly target: string;
      readonly range: ChartReport["range"];
    };

/** The newest report of `query`, starting from the one the page was rendered with (absent when that read failed, with
 * `initialFailure` saying why) and read again after every sample (`/usage`), at the pace of the newest report. Polling
 * pauses while the tab is hidden. A failed read keeps the last report and says why, until a read succeeds again. */
export function useUsage(
  initial: ChartReport | undefined,
  query: UsageQuery,
  initialFailure?: Failure,
): { report?: ChartReport; failure?: Failure } {
  const [report, setReport] = useState(initial);
  const [failure, setFailure] = useState(initialFailure);
  // rigd may restart with another reader mid-watch, so the pace follows each report rather than the first.
  const sampledEvery = useRef(initial?.sampledEvery ?? 1);
  const q = JSON.stringify(query);
  useEffect(() => {
    setReport(initial);
    setFailure(initialFailure);
    if (initial) sampledEvery.current = initial.sampledEvery;
  }, [initial, initialFailure]);
  useEffect(() => {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delay = () => Math.max(sampledEvery.current, 1) * 1000;
    const poll = async () => {
      if (document.visibilityState === "visible") {
        try {
          const response = await fetch(`/usage?q=${encodeURIComponent(q)}`, {
            signal: stop.signal,
            cache: "no-store",
          });
          const outcome = (await response.json()) as Outcome<ChartReport>;
          if (outcome.ok) {
            sampledEvery.current = outcome.value.sampledEvery;
            setReport(outcome.value);
            setFailure(undefined);
          } else setFailure(outcome.failure);
        } catch (error) {
          if (stop.signal.aborted) return;
          setFailure(describeFailure(error));
        }
      }
      if (!stop.signal.aborted) timer = setTimeout(poll, delay());
    };
    timer = setTimeout(poll, delay());
    return () => {
      stop.abort();
      clearTimeout(timer);
    };
  }, [q]);
  return {
    ...(report && { report }),
    ...(failure !== undefined && { failure }),
  };
}

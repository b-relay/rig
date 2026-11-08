"use client";

import { useEffect, useRef, useState } from "react";
// The compact Zod API, as live-refresh.tsx uses it, for the polled report.
import * as z from "zod/mini";
import { USAGE_RANGES } from "../../src/domain/usage-summary";
import { describeFailure, type Failure } from "@/lib/outcome";
import { outcomeReply } from "@/lib/outcome-reply";
import type { ChartReport } from "@/lib/usage";

const measureSchema = z.object({
  average: z.array(z.nullable(z.number())),
  peak: z.optional(z.object({ index: z.number(), value: z.number() })),
  median: z.optional(z.number()),
});
const project = { projectId: z.string(), project: z.string() };
const target = {
  ...project,
  targetId: z.string(),
  target: z.string(),
  targetKind: z.enum(["working", "stable", "preview"]),
};
/** Which series one is, with the identity its scope has (UsageSeries in src/runtime/usage-history.ts): the cards name and
 * colour each by it. */
const seriesSchema = z.discriminatedUnion("scope", [
  z.looseObject({ scope: z.literal("host") }),
  z.looseObject({ scope: z.literal("rig") }),
  z.looseObject({ scope: z.literal("project"), ...project }),
  z.looseObject({ scope: z.literal("target"), ...target }),
  z.looseObject({
    scope: z.literal("component"),
    ...target,
    component: z.string(),
    componentKind: z.enum(["service", "job"]),
  }),
]);
/** A `/usage` report (ChartReport) as the charts draw it. */
const chartReportSchema = z.object({
  range: z.enum(USAGE_RANGES),
  from: z.number(),
  step: z.number().check(z.positive()),
  sampledEvery: z.number().check(z.positive()),
  series: z.array(
    z.object({
      key: z.string(),
      series: seriesSchema,
      now: z.optional(
        z.object({ cpuPercent: z.number(), memoryBytes: z.number() }),
      ),
      cpu: measureSchema,
      memory: measureSchema,
    }),
  ),
});

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
          const outcome = outcomeReply(
            await response.json().catch(() => undefined),
            chartReportSchema,
          );
          if (!outcome)
            setFailure({
              code: "WEB_PROTOCOL",
              message: `The usage read answered ${response.status}.`,
              hint: "Reload the page; if it persists, restart the dashboard.",
            });
          else if (outcome.ok) {
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

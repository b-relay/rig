"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LogsResult, TargetReport } from "@/lib/types";
import type { Failure as FailureShape } from "@/lib/outcome";
import { transportFailure } from "@/lib/reconcile";
import { targetKey, targetSelector } from "@/lib/target";
import { runCommand } from "@/server/actions";
import { Empty, Failure } from "./bits";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const KEPT_LINES = 5000;
const FOLLOW_MS = 1000;
type Entry = LogsResult["entries"][number];
/** The log of one Target, followed a second at a time through the `after` cursor. The first
 * page came with the server render; the Target choice lives in the URL so a refresh keeps it. */
export function LogsFollower({
  project,
  targets,
  selected,
  first,
}: {
  project: string;
  targets: readonly Pick<TargetReport, "name" | "kind">[];
  selected: string | undefined;
  first: LogsResult | undefined;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [lines, setLines] = useState(200);
  const [follow, setFollow] = useState(true);
  const [entries, setEntries] = useState<Entry[]>(first?.entries ?? []);
  const [failure, setFailure] = useState<FailureShape>();
  const pane = useRef<HTMLDivElement>(null);
  const target =
    targets.find((each) => targetKey(each) === selected) ?? targets[0];
  const key = target ? targetKey(target) : undefined;
  const selector = target ? JSON.stringify(targetSelector(target)) : undefined;
  // The served page is adopted once per Target and line count. Live refreshes hand the
  // component a newer page every few seconds; adopting each would replay lines the follow
  // already appended, so the cursor lives here and outlasts renders and follow toggles.
  const served = useRef(first);
  served.current = first;
  const cursor = useRef<string | undefined>(undefined);
  const adopted = useRef<string>(undefined);
  useEffect(() => {
    if (!selector) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      if (follow && !stopped)
        timer = setTimeout(() => void read(cursor.current), FOLLOW_MS);
    };
    const read = async (after: string | undefined) => {
      try {
        const outcome = await runCommand({
          action: "logs",
          project,
          ...(JSON.parse(selector) as ReturnType<typeof targetSelector>),
          ...(after === undefined ? { lines } : { after, lines: 1000 }),
        });
        if (stopped) return;
        if (outcome.ok) {
          const page = outcome.value as LogsResult;
          cursor.current = page.cursor;
          setFailure(undefined);
          if (after === undefined) setEntries(page.entries);
          else if (page.entries.length)
            setEntries((kept) => [...kept, ...page.entries].slice(-KEPT_LINES));
        } else {
          setFailure(outcome.failure);
          // A redeployed Preview is a new Target, so its old cursor never becomes valid again.
          if (after !== undefined) {
            cursor.current = undefined;
            setEntries([]);
          }
        }
      } catch (error) {
        if (stopped) return;
        setFailure(transportFailure(error));
      }
      next();
    };
    const identity = `${project}\n${selector}\n${lines}`;
    if (adopted.current !== identity) {
      adopted.current = identity;
      const page = lines === 200 ? served.current : undefined;
      if (page) {
        setEntries(page.entries);
        setFailure(undefined);
        cursor.current = page.cursor;
      } else {
        cursor.current = undefined;
        void read(undefined);
        return () => {
          stopped = true;
          clearTimeout(timer);
        };
      }
    }
    next();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [project, selector, lines, follow]);
  // Scrolls the log pane only; scrollIntoView would drag the whole page along.
  useEffect(() => {
    const element = pane.current;
    if (follow && element) element.scrollTop = element.scrollHeight;
  }, [entries, follow]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {targets.length ? (
          <Select
            value={key}
            onValueChange={(next) => {
              const query = new URLSearchParams(params);
              query.set("target", next);
              router.replace(`?${query}`);
            }}
          >
            <SelectTrigger size="sm" aria-label="Target">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {targets.map((each) => (
                <SelectItem key={targetKey(each)} value={targetKey(each)}>
                  {each.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Select
          value={String(lines)}
          onValueChange={(next) => setLines(Number(next))}
        >
          <SelectTrigger size="sm" aria-label="Lines">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[100, 200, 1000, 5000].map((count) => (
              <SelectItem key={count} value={String(count)}>
                last {count}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Label className="gap-2 font-normal">
          <Switch checked={follow} onCheckedChange={setFollow} />
          Follow
        </Label>
      </div>
      <Failure failure={failure} />
      {targets.length === 0 ? (
        <Empty>This Project has no recorded Targets.</Empty>
      ) : null}
      <div
        ref={pane}
        className="max-h-[70vh] overflow-y-auto rounded-md bg-deck p-3 font-mono text-xs leading-5 text-on-deck"
      >
        {entries.length === 0 ? (
          <span className="text-deck-muted">No lines yet.</span>
        ) : null}
        {entries.map((entry, index) => (
          <div key={index} className="flex flex-wrap gap-x-3">
            <span className="text-deck-muted">{entry.timestamp}</span>
            <span className="text-busy">{entry.component}</span>
            {entry.stream !== "stdout" ? (
              <span className="sr-only">{entry.stream}</span>
            ) : null}
            <span
              className={cn(
                "basis-full break-all whitespace-pre-wrap sm:min-w-0 sm:flex-1 sm:basis-auto",
                entry.stream === "stderr" && "text-warn",
                entry.stream === "health" && "text-deck-muted",
              )}
            >
              {entry.line}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

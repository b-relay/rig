import { useEffect, useRef, useState } from "react";
import type { LogsResult, TargetReport } from "../types";
import { useApi } from "../hooks";
import { targetKey, targetSelector } from "../target";
import { Empty, Failure, Panel } from "../ui";
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
export function Logs({
  project,
  targets,
}: {
  project: string;
  targets: TargetReport[];
}) {
  const api = useApi();
  const [selected, setSelected] = useState<string>();
  const [lines, setLines] = useState(200);
  const [follow, setFollow] = useState(true);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<unknown>();
  const pane = useRef<HTMLDivElement>(null);
  const target =
    targets.find((each) => targetKey(each) === selected) ?? targets[0];
  const key = target ? targetKey(target) : undefined;
  const selector = target ? JSON.stringify(targetSelector(target)) : undefined;
  useEffect(() => {
    if (!selector) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setEntries([]);
    setError(undefined);
    const read = async (after?: string) => {
      let cursor = after;
      try {
        const page = await api.command(
          {
            action: "logs",
            project,
            ...(JSON.parse(selector) as ReturnType<typeof targetSelector>),
            ...(after === undefined ? { lines } : { after, lines: 1000 }),
          },
          abort.signal,
        );
        if (abort.signal.aborted) return;
        cursor = page.cursor;
        setError(undefined);
        if (page.entries.length)
          setEntries((kept) => [...kept, ...page.entries].slice(-KEPT_LINES));
      } catch (failure) {
        if (abort.signal.aborted) return;
        setError(failure);
        // A redeployed Preview is a new Target, so its old cursor never becomes valid again.
        if (after !== undefined) {
          cursor = undefined;
          setEntries([]);
        }
      }
      if (follow) timer = setTimeout(() => void read(cursor), FOLLOW_MS);
    };
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, project, selector, lines, follow]);
  // Scrolls the log pane only; scrollIntoView would drag the whole page along.
  useEffect(() => {
    const element = pane.current;
    if (follow && element) element.scrollTop = element.scrollHeight;
  }, [entries, follow]);
  return (
    <Panel
      title="Logs"
      actions={
        <>
          {targets.length ? (
            <Select value={key} onValueChange={setSelected}>
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
        </>
      }
    >
      <Failure error={error} />
      {targets.length === 0 ? (
        <Empty>This Project has no recorded Targets.</Empty>
      ) : null}
      <div
        ref={pane}
        className="max-h-[70vh] overflow-y-auto rounded-md bg-sidebar p-3 font-mono text-xs leading-5 text-sidebar-foreground"
      >
        {entries.length === 0 ? (
          <span className="text-sidebar-foreground/60">No lines yet.</span>
        ) : null}
        {entries.map((entry, index) => (
          <div key={index} className="flex flex-wrap gap-x-3">
            <span className="text-sidebar-foreground/60">
              {entry.timestamp}
            </span>
            <span className="text-busy">{entry.component}</span>
            {entry.stream !== "stdout" ? (
              <span className="sr-only">{entry.stream}</span>
            ) : null}
            <span
              className={cn(
                "basis-full break-all whitespace-pre-wrap sm:min-w-0 sm:flex-1 sm:basis-auto",
                entry.stream === "stderr" && "text-warn",
                entry.stream === "health" && "text-sidebar-foreground/70",
              )}
            >
              {entry.line}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

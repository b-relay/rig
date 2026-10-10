"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDownToLine,
  Download,
  Eraser,
  Pause,
  Play,
  Search,
  WrapText,
} from "lucide-react";
import type { Failure as FailureShape } from "@/lib/outcome";
import {
  componentSlot,
  logFilter,
  logText,
  matchesSearch,
  type LogEntry,
  type LogQuery,
} from "@/lib/logs";
import { transportFailure } from "@/lib/reconcile";
import { targetKey, targetSelector } from "@/lib/target";
import type { LogsResult, TargetReport } from "@/lib/types";
import { runCommand } from "@/server/actions";
import { Failure } from "./bits";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const KEPT_LINES = 5000;
const FOLLOW_MS = 1000;
const FIRST_LINES = 200;
const SLOT_CLASS = [
  "text-sky-300",
  "text-violet-300",
  "text-emerald-300",
  "text-amber-300",
  "text-pink-300",
  "text-cyan-300",
];
/** A Target whose log can be read, with the names its lines are recorded under. */
export interface LogTarget extends Pick<TargetReport, "name" | "kind"> {
  components: readonly string[];
}
/** One Target's log, streamed a second at a time through rigd's cursor while following. The
 * component and stream filters narrow what rigd reads; the search box narrows what is shown. The
 * first page came with the server render; the Target choice lives in the URL so a refresh keeps it. */
export function LogViewer({
  project,
  targets,
  selected,
  first,
  pickTarget = true,
}: {
  project: string;
  targets: readonly LogTarget[];
  selected: string | undefined;
  /** The last 200 lines of the selected Target, read by the server for the first paint. */
  first: LogsResult | undefined;
  /** Offer a picker between `targets`; a Target's own page shows only its own. */
  pickTarget?: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [lines, setLines] = useState(FIRST_LINES);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState<LogQuery>({ services: [] });
  const [search, setSearch] = useState("");
  const [wrap, setWrap] = useState(true);
  const [entries, setEntries] = useState<LogEntry[]>(first?.entries ?? []);
  const [failure, setFailure] = useState<FailureShape>();
  const [pinned, setPinned] = useState(true);
  const pane = useRef<HTMLDivElement>(null);
  const target =
    targets.find((each) => targetKey(each) === selected) ?? targets[0];
  const key = target ? targetKey(target) : undefined;
  const selector = target ? JSON.stringify(targetSelector(target)) : undefined;
  const filter = JSON.stringify(logFilter(query) ?? null);
  // The served page is adopted once per Target, line count and filter. Live refreshes hand the
  // component a newer page every few seconds; adopting each would replay lines the follow already
  // appended, so the cursor lives here and outlasts renders and follow toggles.
  const served = useRef(first);
  served.current = first;
  const cursor = useRef<string | undefined>(undefined);
  const adopted = useRef<string>(undefined);
  useEffect(() => {
    if (!selector) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const narrowed = JSON.parse(filter) as ReturnType<typeof logFilter> | null;
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
          ...(narrowed ? { logFilter: narrowed } : {}),
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
    const identity = `${project}\n${selector}\n${lines}\n${filter}`;
    if (adopted.current !== identity) {
      adopted.current = identity;
      const page =
        lines === FIRST_LINES && !narrowed ? served.current : undefined;
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
  }, [project, selector, lines, follow, filter]);
  const shown = useMemo(
    () => entries.filter((entry) => matchesSearch(entry, search)),
    [entries, search],
  );
  // Scrolls the log pane only, and only while the reader is at its end; scrolling up holds the view.
  useEffect(() => {
    const element = pane.current;
    if (pinned && element) element.scrollTop = element.scrollHeight;
  }, [shown, pinned]);
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const components = target?.components ?? [];
  const toggleService = (name: string) =>
    setQuery((current) => ({
      ...current,
      services: current.services.includes(name)
        ? current.services.filter((each) => each !== name)
        : [...current.services, name],
    }));
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-rule bg-sheet shadow-xs">
      <div className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2">
        {pickTarget && targets.length ? (
          <Select
            value={key}
            onValueChange={(next) => {
              const search = new URLSearchParams(params);
              search.set("target", next);
              setQuery({ services: [] });
              router.replace(`?${search}`);
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="Target"
              className="h-8 min-w-36"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {targets.map((each) => (
                <SelectItem key={targetKey(each)} value={targetKey(each)}>
                  {each.name}
                  {each.kind === "preview" ? (
                    <span className="text-muted-foreground">preview</span>
                  ) : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <div className="relative min-w-48 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search the lines shown…"
            aria-label="Search the log"
            className="h-8 pl-8 text-sm md:text-sm"
          />
        </div>
        <Select
          value={query.stream ?? "all"}
          onValueChange={(next) =>
            setQuery((current) => ({
              services: current.services,
              ...(next === "stdout" || next === "stderr"
                ? { stream: next }
                : {}),
            }))
          }
        >
          <SelectTrigger size="sm" aria-label="Stream" className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All streams</SelectItem>
            <SelectItem value="stdout">stdout</SelectItem>
            <SelectItem value="stderr">stderr</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={String(lines)}
          onValueChange={(next) => setLines(Number(next))}
        >
          <SelectTrigger size="sm" aria-label="Lines" className="h-8">
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
        <div className="flex items-center gap-0.5">
          <ToolButton
            label={follow ? "Pause following" : "Follow new lines"}
            pressed={follow}
            onClick={() => {
              setFollow((now) => !now);
              setPinned(true);
            }}
          >
            {follow ? <Pause /> : <Play />}
          </ToolButton>
          <ToolButton
            label={wrap ? "Do not wrap long lines" : "Wrap long lines"}
            pressed={wrap}
            onClick={() => setWrap((now) => !now)}
          >
            <WrapText />
          </ToolButton>
          <ToolButton
            label="Clear the lines shown"
            onClick={() => setEntries([])}
          >
            <Eraser />
          </ToolButton>
          <ToolButton
            label="Download the lines shown"
            onClick={() =>
              download(shown, `${project}-${target?.name ?? "logs"}.log`)
            }
          >
            <Download />
          </ToolButton>
        </div>
      </div>
      {components.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-rule px-3 py-2">
          <span className="mr-1 text-xs text-muted-foreground">Components</span>
          <Chip
            on={query.services.length === 0}
            onClick={() =>
              setQuery((current) => ({ ...current, services: [] }))
            }
          >
            all
          </Chip>
          {components.map((name) => (
            <Chip
              key={name}
              on={query.services.includes(name)}
              onClick={() => toggleService(name)}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full bg-current",
                  SLOT_CLASS[componentSlot(name)],
                )}
              />
              {name}
            </Chip>
          ))}
        </div>
      ) : null}
      {failure ? (
        <div className="border-b border-rule p-3">
          <Failure failure={failure} />
        </div>
      ) : null}
      <div className="relative">
        <div
          ref={pane}
          onScroll={(event) => {
            const element = event.currentTarget;
            setPinned(
              element.scrollHeight - element.scrollTop - element.clientHeight <
                24,
            );
          }}
          role="log"
          aria-live="off"
          className="h-[min(70vh,44rem)] overflow-auto bg-pane px-3 py-2 font-mono text-xs leading-5 text-on-pane"
        >
          {targets.length === 0 ? (
            <span className="text-pane-muted">
              This Project has no recorded Targets.
            </span>
          ) : shown.length === 0 ? (
            <span className="text-pane-muted">
              {entries.length
                ? "No line matches the search."
                : query.services.length || query.stream
                  ? "No line matches these filters yet."
                  : "No lines yet."}
            </span>
          ) : null}
          {shown.map((entry, index) => (
            <div
              key={index}
              className={cn(
                "flex gap-x-3 rounded-sm px-1 hover:bg-white/5",
                wrap ? "flex-wrap sm:flex-nowrap" : "w-max",
                entry.stream === "stderr" && "bg-pane-warn/5",
              )}
            >
              <span
                className="shrink-0 text-pane-muted tabular-nums"
                title={entry.timestamp}
                suppressHydrationWarning
              >
                {clock(entry.timestamp)}
              </span>
              <span
                className={cn(
                  "w-16 shrink-0 truncate",
                  SLOT_CLASS[componentSlot(entry.component)],
                )}
                title={entry.component}
              >
                {entry.component}
              </span>
              <span
                className={cn(
                  "min-w-0",
                  wrap
                    ? "basis-full break-all whitespace-pre-wrap sm:flex-1 sm:basis-auto"
                    : "whitespace-pre",
                  entry.stream === "stderr" && "text-pane-warn",
                  entry.stream === "health" && "text-pane-muted",
                )}
              >
                {entry.stream !== "stdout" ? (
                  <span className="sr-only">{entry.stream} </span>
                ) : null}
                {highlight(entry.line, words)}
              </span>
            </div>
          ))}
        </div>
        {!pinned && shown.length ? (
          <button
            type="button"
            onClick={() => setPinned(true)}
            className="absolute right-4 bottom-4 inline-flex items-center gap-1.5 rounded-full bg-on-pane px-3 py-1.5 text-xs font-medium text-pane shadow-lg"
          >
            <ArrowDownToLine className="size-3.5" aria-hidden /> Latest
          </button>
        ) : null}
      </div>
      <div className="flex items-center gap-3 border-t border-rule px-3 py-1.5 text-xs text-muted-foreground">
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            follow ? "busy-dot bg-good" : "bg-muted-ink",
          )}
        />
        {follow ? "Following" : "Paused"}
        <span className="ml-auto tabular-nums">
          {search
            ? `${shown.length} of ${entries.length} lines`
            : `${entries.length} lines`}
        </span>
      </div>
    </div>
  );
}
function ToolButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-4",
        pressed && "bg-muted text-foreground",
      )}
    >
      {children}
    </button>
  );
}
function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs ring-1 ring-rule ring-inset hover:bg-muted",
        on && "bg-ink text-sheet ring-ink hover:bg-ink/90",
      )}
    >
      {children}
    </button>
  );
}
/** The time of day of an instant on the reader's clock, to the second. */
function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString(undefined, { hour12: false });
}
/** `text` with every searched word marked. */
function highlight(text: string, words: readonly string[]): ReactNode {
  if (!words.length) return text;
  const pattern = new RegExp(
    `(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  return text.split(pattern).map((part, index) =>
    index % 2 ? (
      <mark key={index} className="rounded-sm bg-pane-warn/30 text-on-pane">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
function download(entries: readonly LogEntry[], name: string) {
  const url = URL.createObjectURL(
    new Blob([logText(entries)], { type: "text/plain" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

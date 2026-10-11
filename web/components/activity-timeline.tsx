import Link from "next/link";
import { Activity } from "lucide-react";
import { activityDays } from "@/lib/activity";
import type { ActivityResult } from "@/lib/types";
import { when } from "@/lib/present";
import { projectHref } from "@/lib/target";
import { CARD, Dot, Empty, State } from "./bits";
import { cn } from "@/lib/utils";

type Operation = ActivityResult["operations"][number];
const operationHref = (id: string) =>
  `/activity?operation=${encodeURIComponent(id)}`;

/** Operations newest first as a quiet timeline, grouped by day: a dot for how each ended, what it
 * was and what it touched, and the time it happened, each linking to its own record. */
export function ActivityTimeline({
  operations,
  showProject = true,
  now,
}: {
  operations: readonly Operation[];
  showProject?: boolean;
  /** The instant "Today" is decided against, so a render is stable. */
  now: number;
}) {
  if (operations.length === 0)
    return <Empty icon={Activity}>Nothing has happened yet.</Empty>;
  return (
    <div className="flex flex-col gap-6">
      {activityDays(operations, now).map((day) => (
        <section key={day.label} className="flex flex-col gap-2">
          <h2 className="sticky top-12 z-10 -mx-1 bg-background/90 px-1 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm">
            {day.label}
          </h2>
          <ol className={cn(CARD, "flex flex-col py-1")}>
            {day.operations.map((operation, index) => (
              <li key={operation.id} className="relative flex gap-3 px-4">
                {/* The rail: a hairline through every dot of the day. */}
                <span
                  aria-hidden
                  className={cn(
                    "absolute left-[1.21rem] w-px bg-border",
                    index === 0 ? "top-5" : "top-0",
                    index === day.operations.length - 1 ? "h-5" : "bottom-0",
                  )}
                />
                <span className="relative z-[1] mt-4 flex size-2 shrink-0 items-center justify-center rounded-full ring-4 ring-card">
                  <Dot value={operation.outcome} />
                </span>
                <div
                  className={cn(
                    "flex min-w-0 flex-1 flex-col gap-0.5 py-3 sm:flex-row sm:items-baseline sm:gap-4",
                    index < day.operations.length - 1 && "border-b",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm">
                      <Link
                        href={operationHref(operation.id)}
                        className="font-medium text-foreground no-underline hover:underline"
                      >
                        {operation.action}
                      </Link>
                      {showProject && operation.project ? (
                        <Link
                          href={projectHref(operation.project)}
                          className="text-foreground no-underline hover:underline"
                        >
                          {operation.project}
                        </Link>
                      ) : null}
                      {operation.target ? (
                        <span className="text-muted-foreground">
                          {operation.target}
                        </span>
                      ) : null}
                      <span className="text-xs text-muted-foreground">
                        · {operation.outcome}
                      </span>
                    </p>
                    {operation.message ? (
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {operation.message}
                      </p>
                    ) : null}
                  </div>
                  <time
                    dateTime={operation.occurredAt}
                    title={when(operation.occurredAt)}
                    className="shrink-0 text-xs text-muted-foreground tabular-nums"
                  >
                    {timeOfDay(operation.occurredAt)}
                  </time>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
function timeOfDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}
/** One Operation's full record, when it was asked for by id. */
export function OperationRecord({ operation }: { operation: Operation }) {
  return (
    <section className={cn(CARD, "flex flex-col gap-4 p-4 sm:p-5")}>
      <header className="flex flex-wrap items-center gap-2">
        <Dot value={operation.outcome} className="size-2.5" />
        <h2 className="text-base font-semibold">{operation.action}</h2>
        <span className="text-sm text-muted-foreground">
          {when(operation.occurredAt)}
        </span>
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Operation</dt>
        <dd className="font-mono text-xs break-all">{operation.id}</dd>
        {operation.project ? (
          <>
            <dt className="text-muted-foreground">Project</dt>
            <dd>
              <Link href={projectHref(operation.project)}>
                {operation.project}
              </Link>
            </dd>
          </>
        ) : null}
        {operation.target ? (
          <>
            <dt className="text-muted-foreground">Target</dt>
            <dd>{operation.target}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Outcome</dt>
        <dd>
          <State value={operation.outcome} />
        </dd>
        {operation.message ? (
          <>
            <dt className="text-muted-foreground">Message</dt>
            <dd className="whitespace-pre-wrap">{operation.message}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

import Link from "next/link";
import { Activity, CircleCheck, CircleX } from "lucide-react";
import type { ActivityResult, DoctorReport } from "@/lib/types";
import { ago } from "@/lib/present";
import { cn } from "@/lib/utils";
import { CARD, Dot } from "./bits";

type Operation = ActivityResult["operations"][number];

/** A card of the Monitor pages' side column, with its title, a word on the right, and its content. */
export function SideCard({
  title,
  aside,
  children,
  className,
}: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(CARD, "flex min-w-0 flex-col gap-2 p-4", className)}>
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {aside}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/** Label and value rows, quiet labels on the left. */
export function FactRows({
  rows,
}: {
  /** `wide` rows show from the large layout up, so a half-width card on a phone keeps to the essentials. */
  rows: readonly {
    readonly label: string;
    readonly value: React.ReactNode;
    readonly wide?: boolean;
  }[];
}) {
  return (
    <dl className="flex flex-col text-sm">
      {rows.map(({ label, value, wide }) => (
        <div
          key={label}
          className={cn(
            "flex items-baseline justify-between gap-3 border-t py-1.5 first:border-t-0",
            wide && "hidden lg:flex",
          )}
        >
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 truncate text-right tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Doctor's checks as a compact list, failed ones first with their reason and hint. With `fold`, a report where every
 * check passed is one line on a phone; the list shows from the large layout up. */
export function DoctorList({
  report,
  fold = false,
}: {
  report: DoctorReport;
  fold?: boolean;
}) {
  const failed = report.checks.filter((check) => !check.ok);
  const checks = [...failed, ...report.checks.filter((check) => check.ok)];
  return (
    <SideCard
      title="Doctor"
      aside={
        report.ok ? (
          <>
            <CircleCheck className="size-3.5 text-good" aria-hidden />
            all {report.checks.length} pass
          </>
        ) : (
          <>
            <CircleX className="size-3.5 text-bad" aria-hidden />
            {failed.length} failing
          </>
        )
      }
    >
      <ul
        className={cn(
          "flex flex-col text-sm",
          fold && report.ok && "hidden lg:flex",
        )}
      >
        {checks.map((check) => (
          <li
            key={check.name}
            className={cn(
              "flex flex-col gap-0.5 border-t py-1.5 first:border-t-0 [overflow-wrap:anywhere]",
              !check.ok && "-mx-2 rounded-lg border-t-0 bg-bad-fill px-2 py-2",
              // On a phone the passing checks are one line below; the large layout lists them all.
              check.ok && !report.ok && "hidden lg:flex",
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span
                className={cn(
                  "min-w-0 break-words",
                  !check.ok && "font-medium text-bad",
                )}
              >
                {check.name}
              </span>
              <Dot
                value={check.ok ? "healthy" : "failed"}
                className="size-1.5"
              />
            </span>
            {!check.ok ? (
              <>
                <span className="text-xs">{check.reason ?? check.message}</span>
                {check.hint ? (
                  <span className="text-xs">{check.hint}</span>
                ) : null}
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {!report.ok && report.checks.length > failed.length ? (
        <p className="text-xs text-muted-foreground lg:hidden">
          {report.checks.length - failed.length} other checks pass.
        </p>
      ) : null}
      {report.note ? (
        <p className="hidden text-xs text-muted-foreground lg:block">
          {report.note}
        </p>
      ) : null}
    </SideCard>
  );
}

/** The newest Operations, newest first: how each ended, what it was and touched, and when, each linking to its own
 * record. `project` is shown under each when the feed spans Projects. */
export function ActivityFeed({
  operations,
  showProject,
  now,
  limit = 8,
  scope,
  allHref = "/activity",
}: {
  operations: readonly Operation[];
  showProject: boolean;
  /** The instant "ago" is counted from, so a render is stable. */
  now: number;
  limit?: number;
  /** A word on the card's right, such as the Target the feed is about. */
  scope?: React.ReactNode;
  /** Where the full history is: the Host's Activity, or a Project's. */
  allHref?: string;
}) {
  const latest = [...operations]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, limit);
  return (
    <SideCard title="Activity" aside={scope}>
      {latest.length === 0 ? (
        <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
          <Activity className="size-4" aria-hidden />
          Nothing has happened yet.
        </p>
      ) : (
        <ol className="flex flex-col">
          {latest.map((operation) => (
            <li key={operation.id}>
              <Link
                href={`/activity?operation=${encodeURIComponent(operation.id)}`}
                className="-mx-2 flex gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent"
              >
                <Dot value={operation.outcome} className="mt-1.5 size-1.5" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm">
                    {operation.action}
                    {operation.target ? (
                      <span className="text-muted-foreground">
                        {" "}
                        {operation.target}
                      </span>
                    ) : null}
                    {operation.outcome !== "succeeded" ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · {operation.outcome}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {showProject && operation.project ? (
                      <span className="font-mono text-[11px]">
                        {operation.project} ·{" "}
                      </span>
                    ) : null}
                    {ago(operation.occurredAt, now)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
      <Link
        href={allHref}
        className="text-xs font-medium text-link hover:underline"
      >
        All activity →
      </Link>
    </SideCard>
  );
}

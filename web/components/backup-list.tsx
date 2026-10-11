import type { ReactNode } from "react";
import { Archive } from "lucide-react";
import { formatBytes, type BackupView } from "@/lib/backups";
import { ago, when } from "@/lib/present";
import type { JobReport } from "@/lib/types";
import { HEALTH_DOT, Mono } from "./bits";
import { cn } from "@/lib/utils";

/** A backup job's kept backups in one Target, newest first: when each was made, its size, what made it, and, through
 * `action`, a control per backup (the Jobs tab's Restore). No state of its own, so it renders on the server. */
export function BackupList({
  summary,
  backups,
  now,
  action,
}: {
  summary: NonNullable<JobReport["backup"]>;
  backups: readonly BackupView[];
  now: number;
  action?: (backup: BackupView) => ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5" aria-label="Backups">
      <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
        <Archive className="size-3.5 shrink-0" aria-hidden />
        <span>
          {summary.count} of {summary.keep} kept
          {summary.count ? `, ${formatBytes(summary.bytes)}` : ""}
          {summary.restore ? "" : " · no restore command"}
        </span>
      </p>
      {backups.length ? (
        <ul className="flex max-h-64 flex-col divide-y overflow-y-auto rounded-lg border">
          {backups.map((backup) => (
            <li
              key={backup.id}
              className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    HEALTH_DOT[backup.missing ? "red" : "green"],
                  )}
                />
                <span title={backup.id} className="text-foreground">
                  {when(backup.finishedAt)}
                </span>
                <span className="text-muted-foreground">
                  {ago(backup.finishedAt, now)}
                </span>
                <Mono className="text-muted-foreground">
                  {backup.bytes === undefined ? "?" : formatBytes(backup.bytes)}
                </Mono>
                <span
                  className="text-muted-foreground"
                  title={`Run ${backup.run}`}
                >
                  {backup.trigger === "schedule" ? "scheduled" : "rig run"}
                </span>
                {backup.missing ? (
                  <span className="text-bad">directory deleted</span>
                ) : null}
              </span>
              {action?.(backup)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">
          No backups yet. Back up now makes one; a failed run keeps none.
        </p>
      )}
    </section>
  );
}

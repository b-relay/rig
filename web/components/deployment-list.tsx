"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  GitBranch,
  History,
  RotateCcw,
} from "lucide-react";
import {
  formatDuration,
  rollbackCommand,
  type DeploymentRow,
} from "@/lib/deployments";
import { healthOf } from "@/lib/health";
import { ago, when } from "@/lib/present";
import { targetHref } from "@/lib/target";
import {
  CARD,
  Empty,
  Failure,
  HEALTH_TILE,
  Mono,
  OperationNotice,
} from "./bits";
import { useRun } from "./operations";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const OUTCOME_ICON = {
  deployed: CircleCheck,
  unchanged: CircleDashed,
  failed: CircleX,
};
/** Every deploy, newest first, as a stack of cards: how it ended, its revision, when it ran and how
 * long it took. A deploy of another Commit than the Target runs now can be rolled back to in one
 * click (confirmed), which deploys that exact Commit again. */
export function DeploymentList({
  project,
  rows,
  showTarget = true,
  now,
}: {
  project: string;
  rows: readonly DeploymentRow[];
  showTarget?: boolean;
  /** Epoch milliseconds the server rendered at, so "3 min ago" agrees between server and browser. */
  now: number;
}) {
  const act = useRun();
  const [confirming, setConfirming] = useState<DeploymentRow>();
  if (rows.length === 0)
    return <Empty icon={History}>No deploy is recorded yet.</Empty>;
  return (
    <div className="flex flex-col gap-3">
      <Failure failure={act.failure} />
      <OperationNotice result={act.result} />
      <ol className="flex flex-col gap-2.5">
        {rows.map((row) => {
          const word = row.outcome === "deployed" ? "succeeded" : row.outcome;
          const Icon = OUTCOME_ICON[row.outcome] ?? CircleDashed;
          return (
            <li
              key={row.id}
              className={cn(
                CARD,
                "flex gap-3 p-3 sm:items-center sm:p-4",
                row.current && "ring-1 ring-primary/15",
              )}
            >
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-lg",
                  HEALTH_TILE[healthOf(word)],
                )}
                title={row.outcome}
              >
                <Icon className="size-4" aria-hidden />
                <span className="sr-only">{row.outcome}</span>
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-6">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="font-medium">{row.outcome}</span>
                    {showTarget ? (
                      <>
                        <span className="text-muted-foreground">to</span>
                        <Link
                          href={targetHref(project, row.target)}
                          className="truncate font-medium text-foreground no-underline hover:underline"
                        >
                          {row.target}
                        </Link>
                      </>
                    ) : null}
                    {row.current ? (
                      <span className="rounded-md bg-primary px-1.5 py-px text-[11px] font-medium text-primary-foreground">
                        current
                      </span>
                    ) : null}
                  </div>
                  <span
                    className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
                    title={[row.branch, row.commit].filter(Boolean).join(" @ ")}
                  >
                    <GitBranch className="size-3.5 shrink-0" aria-hidden />
                    <Mono className="truncate break-normal">
                      {row.branch ?? "unknown"}
                      {row.commit ? (
                        <span className="text-foreground">
                          {" "}
                          @ {row.commit.slice(0, 7)}
                        </span>
                      ) : null}
                    </Mono>
                    {row.previousCommit && row.previousCommit !== row.commit ? (
                      <span className="shrink-0">
                        was{" "}
                        <Mono
                          className="break-normal"
                          title={row.previousCommit}
                        >
                          {row.previousCommit.slice(0, 7)}
                        </Mono>
                      </span>
                    ) : null}
                  </span>
                  {row.message ? (
                    <span className="text-xs text-bad">{row.message}</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground sm:flex-col sm:items-end sm:gap-0.5">
                  <span title={when(row.startedAt)} suppressHydrationWarning>
                    {ago(row.startedAt, now)}
                  </span>
                  <span className="tabular-nums">
                    {formatDuration(row.durationMs)}
                  </span>
                </div>
              </div>
              {row.rollback ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 self-center px-2.5 text-xs"
                  disabled={act.busy}
                  onClick={() => setConfirming(row)}
                  title={`Roll ${row.target} back to ${row.commit?.slice(0, 7)}`}
                >
                  <RotateCcw className="size-3.5" />
                  <span className="hidden sm:inline">Roll back to this</span>
                  <span className="sr-only sm:hidden">Roll back to this</span>
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>
      <AlertDialog
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Roll {confirming?.target} back to{" "}
              {confirming?.commit?.slice(0, 7)}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              rigd deploys {confirming?.branch} at that exact Commit and starts
              it, with the rig.yaml committed there. The Commit it runs now
              stays in the history, so you can roll forward the same way.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming)
                  void act.run(rollbackCommand(project, confirming));
                setConfirming(undefined);
              }}
            >
              Roll back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

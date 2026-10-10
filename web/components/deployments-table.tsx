"use client";

import { useState } from "react";
import Link from "next/link";
import { GitBranch, History, RotateCcw } from "lucide-react";
import {
  formatDuration,
  rollbackCommand,
  type DeploymentRow,
} from "@/lib/deployments";
import { ago, when } from "@/lib/present";
import { targetHref } from "@/lib/target";
import { Empty, Failure, Mono, OperationNotice, StatePill } from "./bits";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const HEAD =
  "h-8 px-4 text-[11px] font-medium tracking-wide text-muted-foreground uppercase";
/** Every deploy, newest first, with its revision, when it ran, how it ended and how long it took.
 * A deploy of another Commit than the Target runs now can be rolled back to in one click (confirmed),
 * which deploys that exact Commit again. */
export function DeploymentsTable({
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
    return (
      <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
        <History className="size-4" aria-hidden />
        <Empty>No deploy is recorded yet.</Empty>
      </p>
    );
  return (
    <>
      {act.failure || act.result ? (
        <div className="border-b border-rule p-3">
          <Failure failure={act.failure} />
          <OperationNotice result={act.result} />
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <Table className="min-w-[44rem] text-[13px]">
          <TableHeader>
            <TableRow className="border-rule hover:bg-transparent">
              <TableHead className={HEAD}>Outcome</TableHead>
              {showTarget ? (
                <TableHead className={HEAD}>Target</TableHead>
              ) : null}
              <TableHead className={HEAD}>Revision</TableHead>
              <TableHead className={HEAD}>Started</TableHead>
              <TableHead className={HEAD}>Duration</TableHead>
              <TableHead className={`${HEAD} text-right`}>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className="border-rule/60">
                <TableCell className="px-4 py-2">
                  <span className="flex items-center gap-2">
                    <StatePill
                      value={
                        row.outcome === "deployed" ? "succeeded" : row.outcome
                      }
                    />
                    {row.current ? (
                      <span className="rounded bg-ink px-1.5 text-[11px] font-medium text-sheet">
                        current
                      </span>
                    ) : null}
                  </span>
                  {row.message ? (
                    <span className="mt-0.5 block text-xs text-bad">
                      {row.message}
                    </span>
                  ) : null}
                </TableCell>
                {showTarget ? (
                  <TableCell className="px-4 py-2">
                    <Link
                      href={targetHref(project, row.target)}
                      className="text-ink no-underline hover:underline"
                    >
                      {row.target}
                    </Link>
                  </TableCell>
                ) : null}
                <TableCell className="px-4 py-2">
                  <span className="inline-flex items-center gap-1.5">
                    <GitBranch
                      className="size-3.5 text-muted-foreground"
                      aria-hidden
                    />
                    <span>{row.branch ?? "unknown"}</span>
                    {row.commit ? (
                      <Mono className="break-normal" title={row.commit}>
                        {row.commit.slice(0, 7)}
                      </Mono>
                    ) : null}
                  </span>
                  {row.previousCommit && row.previousCommit !== row.commit ? (
                    <span className="block text-xs text-muted-foreground">
                      was{" "}
                      <Mono className="break-normal" title={row.previousCommit}>
                        {row.previousCommit.slice(0, 7)}
                      </Mono>
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="px-4 py-2">
                  <span title={when(row.startedAt)} suppressHydrationWarning>
                    {ago(row.startedAt, now)}
                  </span>
                </TableCell>
                <TableCell className="px-4 py-2 tabular-nums">
                  {formatDuration(row.durationMs)}
                </TableCell>
                <TableCell className="px-4 py-2 text-right">
                  {row.rollback ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      disabled={act.busy}
                      onClick={() => setConfirming(row)}
                    >
                      <RotateCcw className="size-3.5" /> Roll back to this
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
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
    </>
  );
}

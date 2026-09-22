"use client";

import { useEffect, useState } from "react";
import { Ellipsis, Play, RotateCw, Square, Trash2 } from "lucide-react";
import { servesHost } from "@/lib/present";
import { targetSelector } from "@/lib/target";
import type { OperationResult, TargetReport } from "@/lib/types";
import { Failure, OperationNotice } from "./bits";
import { useRun, type Run } from "./operations";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Action = "up" | "restart" | "down" | "destroy";
const SERVES_NOTE =
  "This Target serves the dashboard you are using. The page loses its connection while rigd finishes and reconciles with rigd's record afterwards.";
const LABEL: Record<Action, string> = {
  up: "Up",
  restart: "Restart",
  down: "Down",
  destroy: "Destroy",
};
/** Up, Restart, Down and, for a Preview, Destroy, behind one menu button. An action that
 * would cut this very page off, or destroy data, is confirmed first; the outcome shows
 * beside the button, or beneath it when `stacked`. */
export function TargetActions({
  project,
  target,
  stacked = false,
}: {
  project: string;
  target: Pick<TargetReport, "name" | "kind" | "route">;
  stacked?: boolean;
}) {
  const act = useRun();
  // The host is only known in the browser; until hydration nothing serves this page.
  const [host, setHost] = useState("");
  useEffect(() => setHost(window.location.host), []);
  const servesThisPage = servesHost(target.route, host);
  const [confirming, setConfirming] = useState<Action>();
  const send = (action: Action) =>
    void act.run({ action, project, ...targetSelector(target) });
  const choose = (action: Action) => {
    const risky = action === "destroy" || (action !== "up" && servesThisPage);
    if (risky) setConfirming(action);
    else send(action);
  };
  return (
    <div
      className={
        stacked
          ? "flex flex-col items-start gap-2"
          : "flex items-center justify-end gap-2"
      }
    >
      {stacked ? null : <Outcome act={act} />}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={act.busy}
            aria-label={`Actions for ${target.name}`}
          >
            {act.busy ? (
              <span
                aria-hidden
                className="busy-dot size-2 rounded-full bg-busy"
              />
            ) : (
              <Ellipsis />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => choose("up")}>
            <Play /> Up
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => choose("restart")}>
            <RotateCw /> Restart
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => choose("down")}>
            <Square /> Down
          </DropdownMenuItem>
          {target.kind === "preview" ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => choose("destroy")}
              >
                <Trash2 /> Destroy
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {stacked ? (
        <>
          <Failure failure={act.failure} />
          <OperationNotice result={act.result} />
        </>
      ) : null}
      <AlertDialog
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming === "destroy"
                ? `Destroy Preview ${target.name}?`
                : `${LABEL[confirming ?? "down"]} ${target.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming === "destroy"
                ? `Its data, logs, and source history are removed.${servesThisPage ? ` ${SERVES_NOTE}` : ""}`
                : SERVES_NOTE}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirming === "destroy" ? "destructive" : "default"}
              onClick={() => {
                if (confirming) send(confirming);
                setConfirming(undefined);
              }}
            >
              {LABEL[confirming ?? "down"]}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
/** The last outcome in a few words, sized for a table cell; the Operation link tells the rest. */
function Outcome({ act }: { act: Run<OperationResult> }) {
  if (act.failure)
    return (
      <a
        href={
          act.failure.operationId
            ? `/activity?operation=${encodeURIComponent(act.failure.operationId)}`
            : "/activity"
        }
        className="max-w-56 truncate text-xs text-bad no-underline hover:underline"
        title={[act.failure.message, act.failure.hint]
          .filter(Boolean)
          .join(" ")}
      >
        {act.failure.code}: {act.failure.message}
      </a>
    );
  if (act.result)
    return (
      <a
        href={`/activity?operation=${encodeURIComponent(act.result.operationId)}`}
        className="text-xs text-good no-underline hover:underline"
        title={act.result.warnings?.join(" ")}
      >
        {act.result.outcome}
        {act.result.warnings?.length ? " ⚠" : ""}
      </a>
    );
  return null;
}

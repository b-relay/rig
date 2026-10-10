"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Ellipsis,
  Logs,
  Play,
  Rocket,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react";
import { servesHost } from "@/lib/present";
import { targetHref, targetSelector } from "@/lib/target";
import { targetVerbs, type TargetVerb } from "@/lib/target-verbs";
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
import { cn } from "@/lib/utils";

const SERVES_NOTE =
  "This Target serves the dashboard you are using. The page loses its connection while rigd finishes and reconciles with rigd's record afterwards.";
const LABEL: Record<TargetVerb, string> = {
  up: "Start",
  restart: "Restart",
  down: "Stop",
  deploy: "Deploy latest",
  destroy: "Destroy",
};
const ICON = {
  up: Play,
  restart: RotateCw,
  down: Square,
  deploy: Rocket,
  destroy: Trash2,
};
type Shown = Pick<TargetReport, "name" | "kind" | "route" | "branch" | "state">;
/** Start, Restart, Stop, Deploy latest and, for a Preview, Destroy. `menu` puts them all behind one
 * button, for a dense table; `buttons` shows the ones the Target's state calls for as icon buttons
 * with the rest in a menu, for cards and headers. An action that would cut this very page off,
 * deploy, or destroy data is confirmed first; the outcome shows beside the controls, or beneath
 * them when `stacked`. */
export function TargetActions({
  project,
  target,
  layout = "menu",
  stacked = false,
  compact = false,
}: {
  project: string;
  target: Shown;
  layout?: "menu" | "buttons";
  stacked?: boolean;
  /** Icon buttons without their words, for a narrow card. */
  compact?: boolean;
}) {
  const act = useRun();
  // The host is only known in the browser; until hydration nothing serves this page.
  const [host, setHost] = useState("");
  useEffect(() => setHost(window.location.host), []);
  const servesThisPage = servesHost(target.route, host);
  const [confirming, setConfirming] = useState<TargetVerb>();
  const verbs = targetVerbs(target);
  const send = (verb: TargetVerb) =>
    void act.run(
      verb === "deploy"
        ? {
            action: "deploy",
            project,
            ...targetSelector(target),
            // A Preview is deployed again from its own Branch; the stable Target from the Production Branch.
            ...(target.kind === "preview" && target.branch
              ? { branch: target.branch }
              : {}),
          }
        : { action: verb, project, ...targetSelector(target) },
    );
  const choose = (verb: TargetVerb) => {
    const risky =
      verb === "destroy" ||
      verb === "deploy" ||
      (verb !== "up" && servesThisPage);
    if (risky) setConfirming(verb);
    else send(verb);
  };
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={act.busy}
          aria-label={`Actions for ${target.name}`}
        >
          {act.busy && layout === "menu" ? (
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
        {verbs.all
          .filter((verb) => verb !== "destroy")
          .map((verb) => {
            const Icon = ICON[verb];
            return (
              <DropdownMenuItem key={verb} onSelect={() => choose(verb)}>
                <Icon /> {LABEL[verb]}
              </DropdownMenuItem>
            );
          })}
        <DropdownMenuItem asChild>
          <Link href={`${targetHref(project, target.name)}/logs`}>
            <Logs /> Logs
          </Link>
        </DropdownMenuItem>
        {verbs.all.includes("destroy") ? (
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
  );
  return (
    <div
      className={
        stacked
          ? "flex flex-col items-start gap-2"
          : "flex items-center justify-end gap-1"
      }
    >
      {stacked ? null : <Outcome act={act} />}
      <div className="flex items-center gap-1">
        {layout === "buttons"
          ? verbs.primary.map((verb) => {
              const Icon = ICON[verb];
              return (
                <Button
                  key={verb}
                  variant="outline"
                  size="sm"
                  disabled={act.busy}
                  onClick={() => choose(verb)}
                  title={`${LABEL[verb]} ${target.name}`}
                  className="h-7 px-2 text-xs"
                >
                  <Icon className="size-3.5" />
                  <span
                    className={cn(
                      compact
                        ? "sr-only"
                        : stacked
                          ? "inline"
                          : "hidden xl:inline",
                    )}
                  >
                    {LABEL[verb]}
                  </span>
                </Button>
              );
            })
          : null}
        {layout === "buttons" && act.busy ? (
          <span
            aria-label="Working"
            className="busy-dot mx-1 size-2 rounded-full bg-busy"
          />
        ) : null}
        {menu}
      </div>
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
                : confirming === "deploy"
                  ? `Deploy the latest ${target.kind === "preview" ? (target.branch ?? "Branch") : "Production Branch"} to ${target.name}?`
                  : `${LABEL[confirming ?? "down"]} ${target.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming === "destroy"
                ? `Its data, logs, and source history are removed.${servesThisPage ? ` ${SERVES_NOTE}` : ""}`
                : confirming === "deploy"
                  ? `rigd deploys the head Commit of ${target.kind === "preview" ? (target.branch ?? "its Branch") : "the Production Branch"} and starts it; a Commit already deployed is left as it is.${servesThisPage ? ` ${SERVES_NOTE}` : ""}`
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

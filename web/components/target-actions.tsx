"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  CircleAlert,
  CircleCheck,
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
 * button; `card` adds a Start button beside it while the Target is not running, for the matrix's
 * Target cards; `buttons` shows the ones the Target's state calls for as buttons with the rest in a
 * menu, for headers. An action that would cut this very page off,
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
  layout?: "menu" | "card" | "buttons";
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
  // The verb the dialog was opened for; it outlives the close animation so the text never changes mid-fade.
  const [asked, setAsked] = useState<TargetVerb>("down");
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
      (verb !== "up" && servesThisPage) ||
      // Stopping or restarting production takes a second click.
      (verb !== "up" && target.kind === "stable");
    if (risky) {
      setAsked(verb);
      setConfirming(verb);
    } else send(verb);
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
          {act.busy && layout !== "buttons" ? (
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
          <Link
            href={`${targetHref(project, target.name)}/logs`}
            className="text-popover-foreground no-underline"
          >
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
      {stacked ? null : layout === "card" ? (
        <OutcomeMark act={act} target={target.name} />
      ) : (
        <Outcome act={act} />
      )}
      <div className="flex items-center gap-1">
        {layout === "card" && verbs.primary.includes("up") ? (
          <Button
            variant="outline"
            size="xs"
            disabled={act.busy}
            onClick={() => choose("up")}
            title={`Start ${target.name}`}
            className="h-7 px-2"
          >
            <Play className="size-3" />
            {/* The word only where the card (a size container) has room beside the name. */}
            <span className="sr-only @[13.5rem]:not-sr-only">Start</span>
          </Button>
        ) : null}
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
              {asked === "destroy"
                ? `Destroy Preview ${target.name}?`
                : asked === "deploy"
                  ? `Deploy the latest ${target.kind === "preview" ? (target.branch ?? "Branch") : "Production Branch"} to ${target.name}?`
                  : `${LABEL[asked]} ${target.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {[
                asked === "destroy"
                  ? "Its data, logs, and source history are removed."
                  : asked === "deploy"
                    ? `rigd deploys the head Commit of ${target.kind === "preview" ? (target.branch ?? "its Branch") : "the Production Branch"} and starts it; a Commit already deployed is left as it is.`
                    : target.kind === "stable"
                      ? `This is the stable Target${target.route ? `, serving ${target.route}` : ""}; it ${asked === "down" ? "stays down until it is started again" : "is unavailable while it restarts"}.`
                      : undefined,
                servesThisPage ? SERVES_NOTE : undefined,
              ]
                .filter(Boolean)
                .join(" ")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={asked === "destroy" ? "destructive" : "default"}
              onClick={() => {
                if (confirming) send(confirming);
                setConfirming(undefined);
              }}
            >
              {LABEL[asked]}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
/** The last outcome as one small mark, for a card with no room for words; the tooltip and the
 * Operation link tell the rest. */
function OutcomeMark({
  act,
  target,
}: {
  act: Run<OperationResult>;
  target: string;
}) {
  const [open, setOpen] = useState(false);
  const failure = act.failure;
  const result = act.result;
  if (!failure && !result) return null;
  const text = failure
    ? `${failure.code}: ${failure.message}${failure.hint ? ` ${failure.hint}` : ""}`
    : `${result?.outcome}${result?.warnings?.length ? `. ${result.warnings.join(" ")}` : ""}`;
  // A tooltip alone never reaches a phone, so a tap opens the whole outcome.
  return (
    <>
      <button
        type="button"
        title={text}
        aria-label={`Last action on ${target}: ${text}`}
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-md hover:bg-muted",
          failure ? "text-bad" : "text-good",
        )}
      >
        {failure ? (
          <CircleAlert className="size-4" aria-hidden />
        ) : (
          <CircleCheck className="size-4" aria-hidden />
        )}
      </button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Last action on {target}</AlertDialogTitle>
            <AlertDialogDescription className="sr-only">
              {text}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Failure failure={failure} />
          <OperationNotice result={result} />
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
/** The last outcome in a few words; the Operation link tells the rest. */
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

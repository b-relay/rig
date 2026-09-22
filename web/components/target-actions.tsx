"use client";

import { useEffect, useState } from "react";
import { Play, RotateCw, Square, Trash2 } from "lucide-react";
import { servesHost } from "@/lib/present";
import { targetSelector } from "@/lib/target";
import type { TargetReport } from "@/lib/types";
import { Failure, OperationNotice } from "./bits";
import { Confirm } from "./confirm";
import { useRun } from "./operations";
import { Button } from "@/components/ui/button";

const SERVES_NOTE =
  "This Target serves the dashboard you are using. The page loses its connection while rigd finishes and reconciles with rigd's record afterwards.";
/** Up, Restart, Down and, for a Preview, Destroy; the outcome shows beneath the row. */
export function TargetActions({
  project,
  target,
  compact = false,
}: {
  project: string;
  target: Pick<TargetReport, "name" | "kind" | "route">;
  /** Icon-only buttons for a table cell. */
  compact?: boolean;
}) {
  const act = useRun();
  // The host is only known in the browser; until hydration nothing serves this page.
  const [host, setHost] = useState("");
  useEffect(() => setHost(window.location.host), []);
  const servesThisPage = servesHost(target.route, host);
  const send = (action: "up" | "down" | "restart" | "destroy") =>
    void act.run({ action, project, ...targetSelector(target) });
  const size = compact ? "icon-sm" : "sm";
  const label = (text: string) =>
    compact ? <span className="sr-only">{text}</span> : text;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        <Button
          variant="outline"
          size={size}
          disabled={act.busy}
          onClick={() => send("up")}
          title="Up"
        >
          <Play />
          {label("Up")}
        </Button>
        <Confirm
          when={servesThisPage}
          title={`Restart ${target.name}?`}
          description={SERVES_NOTE}
          confirmLabel="Restart"
          onConfirm={() => send("restart")}
        >
          <Button
            variant="outline"
            size={size}
            disabled={act.busy}
            title="Restart"
          >
            <RotateCw />
            {label("Restart")}
          </Button>
        </Confirm>
        <Confirm
          when={servesThisPage}
          title={`Stop ${target.name}?`}
          description={SERVES_NOTE}
          confirmLabel="Down"
          onConfirm={() => send("down")}
        >
          <Button
            variant="outline"
            size={size}
            disabled={act.busy}
            title="Down"
          >
            <Square />
            {label("Down")}
          </Button>
        </Confirm>
        {target.kind === "preview" ? (
          <Confirm
            title={`Destroy Preview ${target.name}?`}
            description={`Its data, logs, and source history are removed.${servesThisPage ? ` ${SERVES_NOTE}` : ""}`}
            confirmLabel="Destroy"
            destructive
            onConfirm={() => send("destroy")}
          >
            <Button
              variant="outline"
              size={size}
              disabled={act.busy}
              title="Destroy"
              className="text-bad hover:text-bad"
            >
              <Trash2 />
              {label("Destroy")}
            </Button>
          </Confirm>
        ) : null}
      </div>
      {act.busy ? (
        <p className="text-xs text-muted-foreground">
          <span
            aria-hidden
            className="busy-dot mr-1.5 inline-block size-2 rounded-full bg-busy"
          />
          Working…
        </p>
      ) : null}
      <Failure failure={act.failure} />
      <OperationNotice result={act.result} />
    </div>
  );
}

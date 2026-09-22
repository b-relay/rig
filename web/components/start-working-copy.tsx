"use client";

import { Play } from "lucide-react";
import { Failure, OperationNotice } from "./bits";
import { useRun } from "./operations";
import { Button } from "@/components/ui/button";

/** Starts a Project's Working copy when the status report lists none yet. */
export function StartWorkingCopy({
  project,
  compact = false,
}: {
  project: string;
  /** A small button alone, for a table row; the outcome shows in the refreshed row. */
  compact?: boolean;
}) {
  const act = useRun();
  const button = (
    <Button
      size={compact ? "xs" : "sm"}
      variant="outline"
      disabled={act.busy}
      onClick={() => void act.run({ action: "up", project })}
    >
      <Play />
      {act.busy ? "Starting…" : compact ? "Start" : "Start Working copy"}
    </Button>
  );
  if (compact)
    return (
      <span className="inline-flex items-center gap-2">
        {act.failure ? (
          <span className="text-xs text-bad" title={act.failure.message}>
            {act.failure.code}
          </span>
        ) : null}
        {button}
      </span>
    );
  return (
    <div className="flex flex-col gap-2">
      <div>{button}</div>
      <Failure failure={act.failure} />
      <OperationNotice result={act.result} />
    </div>
  );
}

"use client";

import { Play } from "lucide-react";
import { Failure, OperationNotice } from "./bits";
import { useRun } from "./operations";
import { Button } from "@/components/ui/button";

/** Starts a Project's Working copy when the status report lists none yet. */
export function StartWorkingCopy({ project }: { project: string }) {
  const act = useRun();
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={act.busy}
          onClick={() => void act.run({ action: "up", project })}
        >
          <Play />
          {act.busy ? "Starting…" : "Start Working copy"}
        </Button>
      </div>
      <Failure failure={act.failure} />
      <OperationNotice result={act.result} />
    </div>
  );
}

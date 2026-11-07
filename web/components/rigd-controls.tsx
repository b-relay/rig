"use client";

import type { QueueResult } from "@/lib/types";
import { Failure, Notice, Section } from "./bits";
import { Confirm } from "./confirm";
import { useRun } from "./operations";
import { Button } from "@/components/ui/button";

/** What rigd's admission is now, as its queue read says, so a reload and another browser see what the page that prepared it
 * saw. Unknown when that read failed: both buttons are offered, and rigd decides. */
export function RigdControls({
  draining,
  known = true,
}: {
  draining?: QueueResult["draining"];
  known?: boolean;
}) {
  const drain = useRun<{ ready: true } | { cancelled: true }>();
  const prepared = draining === "uninstall-prepared";
  return (
    <Section
      title="Uninstall readiness"
      tone="danger"
      description={
        <>
          Preparing makes rigd refuse lifecycle and deploy commands so{" "}
          <code>rigd uninstall</code> can stop it safely. It succeeds only when
          every Target is stopped. Cancel returns rigd to normal service.
        </>
      }
    >
      {prepared ? (
        <Notice tone="warn" title="Prepared for uninstall">
          rigd is refusing new work. Run <code>rigd uninstall</code> to finish,
          or cancel to return it to normal service.
        </Notice>
      ) : null}
      {draining === "stopping" ? (
        <Notice tone="warn" title="rigd is stopping">
          It is finishing what it runs and refuses new work; the next rigd
          accepts it again.
        </Notice>
      ) : null}
      {draining === "stopping" ? null : (
        <div className="flex flex-wrap gap-2">
          {prepared ? null : (
            <Confirm
              title="Prepare rigd for uninstall?"
              description="rigd will refuse lifecycle and deploy commands until this is cancelled."
              confirmLabel="Prepare uninstall"
              destructive
              onConfirm={() => void drain.run({ action: "prepare-uninstall" })}
            >
              <Button variant="destructive" disabled={drain.busy}>
                Prepare uninstall
              </Button>
            </Confirm>
          )}
          {prepared || !known ? (
            <Button
              variant="outline"
              disabled={drain.busy}
              onClick={() => void drain.run({ action: "cancel-uninstall" })}
            >
              Cancel uninstall
            </Button>
          ) : null}
        </div>
      )}
      <Failure failure={drain.failure} />
    </Section>
  );
}

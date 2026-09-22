"use client";

import { Failure, Notice, Section } from "./bits";
import { Confirm } from "./confirm";
import { useRun } from "./operations";
import { Button } from "@/components/ui/button";

export function RigdControls() {
  const drain = useRun<{ ready: true } | { cancelled: true }>();
  return (
    <Section
      title="Uninstall readiness"
      description={
        <>
          Preparing makes rigd refuse lifecycle and deploy commands so{" "}
          <code>rigd uninstall</code> can stop it safely. It succeeds only when
          every Target is stopped. Cancel returns rigd to normal service.
        </>
      }
    >
      <div className="flex flex-wrap gap-2">
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
        <Button
          variant="outline"
          disabled={drain.busy}
          onClick={() => void drain.run({ action: "cancel-uninstall" })}
        >
          Cancel uninstall
        </Button>
      </div>
      <Failure failure={drain.failure} />
      {drain.result ? (
        <Notice tone="good">
          {"ready" in drain.result
            ? "rigd is ready to be uninstalled and is refusing new work."
            : "rigd is accepting commands again."}
        </Notice>
      ) : null}
    </Section>
  );
}

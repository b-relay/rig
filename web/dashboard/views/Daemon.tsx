import type { DaemonHealth, QueueResult } from "../types";
import { useAct, useApi } from "../hooks";
import { Confirm, Empty, Facts, Failure, Notice, Panel, when } from "../ui";
import { Button } from "@/components/ui/button";

export function Daemon({
  health,
  queue,
}: {
  health: DaemonHealth | undefined;
  queue: QueueResult | undefined;
}) {
  const api = useApi();
  const drain = useAct<{ ready: true } | { cancelled: true }>();
  return (
    <>
      <h1 className="text-3xl font-bold [font-stretch:115%]">rigd</h1>
      <Panel title="Daemon">
        <Facts
          items={[
            ["Version", health?.version ?? "unknown"],
            ["Process", health?.pid],
            ["Instance", health?.instanceId],
          ]}
        />
      </Panel>
      <Panel title="Operation queue">
        {queue?.running ? (
          <Facts
            items={[
              [
                "Running",
                `${queue.running.action} ${queue.running.project ?? ""} ${queue.running.target ?? ""}`,
              ],
              ["Started", when(queue.running.startedAt)],
              ["Operation", queue.running.operationId],
              ["Waiting", queue.waiting],
            ]}
          />
        ) : (
          <Empty>Nothing is running; {queue?.waiting ?? 0} waiting.</Empty>
        )}
      </Panel>
      <Panel
        title="Uninstall readiness"
        description={
          <>
            Preparing makes rigd refuse lifecycle and deploy commands so{" "}
            <code>rigd uninstall</code> can stop it safely. It succeeds only
            when every Target is stopped. Cancel returns rigd to normal service.
          </>
        }
      >
        <div className="flex flex-wrap gap-2">
          <Confirm
            title="Prepare rigd for uninstall?"
            description="rigd will refuse lifecycle and deploy commands until this is cancelled."
            confirmLabel="Prepare uninstall"
            destructive
            onConfirm={() =>
              void drain.run(() => api.command({ action: "prepare-uninstall" }))
            }
          >
            <Button variant="destructive" disabled={drain.busy}>
              Prepare uninstall
            </Button>
          </Confirm>
          <Button
            variant="outline"
            disabled={drain.busy}
            onClick={() =>
              void drain.run(() => api.command({ action: "cancel-uninstall" }))
            }
          >
            Cancel uninstall
          </Button>
        </div>
        <Failure error={drain.error} />
        {drain.result ? (
          <Notice tone="good">
            {"ready" in drain.result
              ? "rigd is ready to be uninstalled and is refusing new work."
              : "rigd is accepting commands again."}
          </Notice>
        ) : null}
      </Panel>
    </>
  );
}

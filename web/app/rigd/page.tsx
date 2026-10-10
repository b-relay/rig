import type { Metadata } from "next";
import { attempt } from "@/lib/outcome";
import { when } from "@/lib/present";
import type { DaemonHealth, QueueResult } from "@/lib/types";
import { daemon, read } from "@/server/daemon";
import { site } from "@/server/site";
import { Empty, Facts, Failure, PageHeader, Section } from "@/components/bits";
import { RigdControls } from "@/components/rigd-controls";

export const metadata: Metadata = { title: "rigd" };
export default async function RigdPage() {
  const [health, queue] = await Promise.all([
    attempt(daemon().then((client) => client.health())),
    attempt(read({ action: "queue" })),
  ]);
  const settings = site();
  const queued = queue.ok ? (queue.value as QueueResult) : undefined;
  // Operations on different Targets run side by side; rigd's own brief supervision passes are left out.
  const running = (
    queued?.operations ?? (queued?.running ? [queued.running] : [])
  ).filter(
    (operation) =>
      operation.action !== "supervise" && operation.action !== "reconcile",
  );
  return (
    <>
      <PageHeader
        title="rigd"
        description={
          settings.sandboxRoot
            ? "This copy of the site is a Preview: it drives a throwaway rigd of its own, seeded with demo Projects."
            : "The daemon that owns every process, route and record on this Mac."
        }
      />
      <Section title="Daemon">
        {health.ok ? (
          <Facts
            items={[
              ["Version", (health.value as DaemonHealth).version ?? "unknown"],
              [
                "Process",
                <code key="p">{(health.value as DaemonHealth).pid}</code>,
              ],
              [
                "Instance",
                <code key="i">
                  {(health.value as DaemonHealth).instanceId}
                </code>,
              ],
              ["Rig root", <code key="r">{settings.root}</code>],
            ]}
          />
        ) : (
          <Failure failure={health.failure} />
        )}
      </Section>
      <Section title="Operation queue">
        {!queue.ok ? <Failure failure={queue.failure} /> : null}
        {running.map((operation) => (
          <Facts
            key={operation.operationId}
            items={[
              [
                "Running",
                [operation.action, operation.project, operation.target]
                  .filter(Boolean)
                  .join(" "),
              ],
              ["Started", when(operation.startedAt)],
              [
                "Operation",
                <a
                  key="o"
                  href={`/activity?operation=${encodeURIComponent(operation.operationId)}`}
                  className="font-mono text-xs"
                >
                  {operation.operationId}
                </a>,
              ],
            ]}
          />
        ))}
        {running.length ? (
          <Empty>{queued?.waiting ?? 0} waiting.</Empty>
        ) : queued ? (
          <Empty>Nothing is running; {queued.waiting} waiting.</Empty>
        ) : null}
      </Section>
      <RigdControls />
    </>
  );
}

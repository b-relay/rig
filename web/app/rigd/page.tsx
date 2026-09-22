import type { Metadata } from "next";
import { attempt } from "@/lib/outcome";
import { when } from "@/lib/present";
import type { DaemonHealth, QueueResult } from "@/lib/types";
import { daemon, read } from "@/server/daemon";
import { site } from "@/server/site";
import { Empty, Facts, Failure, Section } from "@/components/bits";
import { RigdControls } from "@/components/rigd-controls";

export const metadata: Metadata = { title: "rigd" };
export default async function RigdPage() {
  const [health, queue] = await Promise.all([
    attempt(daemon().then((client) => client.health())),
    attempt(read({ action: "queue" })),
  ]);
  const settings = site();
  const queued = queue.ok ? (queue.value as QueueResult) : undefined;
  const running = queued?.running;
  return (
    <>
      <div>
        <h1 className="title text-2xl">rigd</h1>
        <p className="text-sm text-muted-foreground">
          {settings.sandboxRoot
            ? "This copy of the site is a Preview: it drives a throwaway rigd of its own, seeded with demo Projects."
            : "The daemon that owns every process, route and record on this Mac."}
        </p>
      </div>
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
        {running ? (
          <Facts
            items={[
              [
                "Running",
                [running.action, running.project, running.target]
                  .filter(Boolean)
                  .join(" "),
              ],
              ["Started", when(running.startedAt)],
              [
                "Operation",
                <a
                  key="o"
                  href={`/activity?operation=${encodeURIComponent(running.operationId)}`}
                  className="font-mono text-xs"
                >
                  {running.operationId}
                </a>,
              ],
              ["Waiting", queued?.waiting ?? 0],
            ]}
          />
        ) : queued ? (
          <Empty>Nothing is running; {queued.waiting} waiting.</Empty>
        ) : null}
      </Section>
      <RigdControls />
    </>
  );
}

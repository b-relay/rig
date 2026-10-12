import type { Metadata } from "next";
import { availableParallelism, hostname, totalmem } from "node:os";
import { attempt } from "@/lib/outcome";
import type {
  ActivityResult,
  DaemonHealth,
  DoctorReport,
  QueueResult,
} from "@/lib/types";
import { bytes, chartReport, rangeOf } from "@/lib/usage";
import { daemon, read } from "@/server/daemon";
import { site } from "@/server/site";
import { Failure, PageHeader } from "@/components/bits";
import { HostMonitor } from "@/components/host-monitor";
import {
  ActivityFeed,
  DoctorList,
  FactRows,
  SideCard,
} from "@/components/monitor-side";
import { RigdControls } from "@/components/rigd-controls";
import { RangeTabs } from "@/components/usage-range";

export const metadata: Metadata = { title: "Monitor" };
/** This Mac at a glance: rigd and its queue, Doctor's Host checks, Activity for every Project, and what every Project,
 * Rig itself and the Host use, live. */
export default async function MonitorPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const range = rangeOf((await searchParams).range);
  const [health, queue, doctor, activity, usage] = await Promise.all([
    attempt(daemon().then((client) => client.health())),
    attempt(read({ action: "queue" })),
    attempt(read({ action: "doctor" })),
    attempt(read({ action: "activity" })),
    attempt(read({ action: "monitor", host: true, range })),
  ]);
  const operations = activity.ok
    ? (activity.value as ActivityResult).operations
    : [];
  const queued = queue.ok ? (queue.value as QueueResult) : undefined;
  const running = (
    queued?.operations ?? (queued?.running ? [queued.running] : [])
  ).filter(
    (operation) =>
      operation.action !== "supervise" && operation.action !== "reconcile",
  );
  return (
    <>
      <PageHeader
        title="Monitor"
        description={`${hostname().replace(/\.local$/, "")} · ${availableParallelism()} cores · ${bytes(totalmem())} memory`}
        actions={<RangeTabs current={range} />}
      />
      {usage.ok ? (
        <HostMonitor
          initial={chartReport(usage.value)}
          operations={operations}
          rigd={
            health.ok ? (
              <FactRows
                rows={[
                  {
                    label: "Version",
                    value: (health.value as DaemonHealth).version ?? "unknown",
                  },
                  {
                    label: "Process",
                    value: (health.value as DaemonHealth).pid,
                    wide: true,
                  },
                  {
                    label: "Rig root",
                    wide: true,
                    value: (
                      <code className="font-mono text-xs">{site().root}</code>
                    ),
                  },
                  {
                    label: "Queue",
                    value: running.length
                      ? `${running.length} running · ${queued?.waiting ?? 0} waiting`
                      : queued
                        ? `idle · ${queued.waiting} waiting`
                        : "unknown",
                  },
                ]}
              />
            ) : (
              <Failure failure={health.failure} />
            )
          }
          doctor={
            doctor.ok ? (
              <DoctorList report={doctor.value as DoctorReport} />
            ) : (
              <SideCard title="Doctor">
                <Failure failure={doctor.failure} />
              </SideCard>
            )
          }
          activity={
            <ActivityFeed
              operations={operations}
              showProject
              now={Date.now()}
              scope="all Projects"
            />
          }
          controls={
            <details className="group text-sm">
              <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground">
                Uninstall readiness…
              </summary>
              <div className="mt-3">
                <RigdControls />
              </div>
            </details>
          }
        />
      ) : (
        <Failure failure={usage.failure} />
      )}
    </>
  );
}

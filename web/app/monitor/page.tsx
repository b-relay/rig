import type { Metadata } from "next";
import { availableParallelism, hostname, totalmem } from "node:os";
import { attempt } from "@/lib/outcome";
import type { DoctorReport } from "@/lib/types";
import { bytes, chartReport, presetWindow, rangeOf } from "@/lib/usage";
import { read } from "@/server/daemon";
import { pagePulse } from "@/server/pulse";
import { projectList } from "@/server/status";
import { site } from "@/server/site";
import { PageHeader } from "@/components/bits";
import { HostMonitor } from "@/components/host-monitor";
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
  // rigd's health, its queue and Activity are the page's pulse readings, which the top bar and the sidebar read too.
  const [{ readings }, doctor, usage, list] = await Promise.all([
    pagePulse(),
    attempt(read({ action: "doctor" })),
    attempt(
      read({
        action: "monitor",
        host: true,
        window: presetWindow(range, Date.now()),
      }),
    ),
    projectList(),
  ]);
  const { health, queue, activity } = readings;
  const now = Date.now();
  const operations = activity.ok ? activity.value.operations : [];
  const queued = queue.ok ? queue.value : undefined;
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
      <HostMonitor
        {...(usage.ok
          ? { initial: chartReport(usage.value, range) }
          : { initialFailure: usage.failure })}
        range={range}
        projects={list.ok ? list.value.projects.map((each) => each.name) : []}
        operations={operations}
        now={now}
        rigd={
          health.ok
            ? {
                facts: [
                  {
                    label: "Version",
                    value: health.value.version ?? "unknown",
                  },
                  {
                    label: "Process",
                    value: String(health.value.pid),
                    wide: true,
                  },
                  {
                    label: "Rig root",
                    value: site().root,
                    wide: true,
                    mono: true,
                  },
                  {
                    label: "Queue",
                    value: running.length
                      ? `${running.length} running · ${queued?.waiting ?? 0} waiting`
                      : queued
                        ? `idle · ${queued.waiting} waiting`
                        : "unknown",
                  },
                  ...(queued?.draining
                    ? [
                        {
                          label: "New work",
                          value:
                            queued.draining === "uninstall-prepared"
                              ? "refused: prepared for uninstall"
                              : "refused: rigd is stopping",
                        },
                      ]
                    : []),
                ],
                running,
              }
            : { failure: health.failure }
        }
        doctor={
          doctor.ok ? { ok: true, value: doctor.value as DoctorReport } : doctor
        }
        {...(!activity.ok && { activityFailure: activity.failure })}
        {...(queued?.draining && { draining: queued.draining })}
        queueRead={queued !== undefined}
      />
    </>
  );
}

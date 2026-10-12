import { attempt } from "@/lib/outcome";
import type { ActivityResult, DoctorReport } from "@/lib/types";
import { rangeOf } from "@/lib/usage";
import { projectHref } from "@/lib/target";
import { read } from "@/server/daemon";
import { projectMonitor } from "@/server/monitor";
import { project } from "@/server/project";
import { Failure } from "@/components/bits";
import { ActivityFeed, DoctorList, SideCard } from "@/components/monitor-side";
import { ProjectMonitor } from "@/components/project-monitor";
import { RangeTabs } from "@/components/usage-range";

/** One Project's CPU and memory, Target by Target, beside its Doctor checks and its Activity. `?target=` picks the
 * Target (the chip beside the Project's name switches it), `?range=` the span. */
export default async function ProjectMonitorPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ target?: string; range?: string }>;
}) {
  const found = await project(params);
  const query = await searchParams;
  const range = rangeOf(query.range);
  const [view, doctor, activity] = await Promise.all([
    projectMonitor(found.name, range, query.target),
    attempt(read({ action: "doctor", project: found.name })),
    attempt(read({ action: "activity", project: found.name })),
  ]);
  const { target, usage } = view;
  const operations = activity.ok
    ? (activity.value as ActivityResult).operations
    : [];
  const now = Date.now();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <RangeTabs current={range} query={{ target }} />
      </div>
      <ProjectMonitor
        project={found.name}
        {...(usage.ok
          ? { initial: usage.value }
          : { initialFailure: usage.failure })}
        range={range}
        target={target}
        inventory={view.inventory}
        operations={operations}
        now={now}
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
            operations={operations.filter(
              (operation) => target === "all" || operation.target === target,
            )}
            showProject={false}
            now={now}
            scope={
              <span className="font-mono">
                {target === "all" ? "all targets" : target}
              </span>
            }
            allHref={`${projectHref(found.name)}/activity`}
            {...(!activity.ok && { failure: activity.failure })}
          />
        }
      />
    </div>
  );
}

import { attempt } from "@/lib/outcome";
import type { ActivityResult } from "@/lib/types";
import { read } from "@/server/daemon";
import { project } from "@/server/project";
import { ActivityTimeline } from "@/components/activity-timeline";
import { Failure } from "@/components/bits";

/** What rigd has done to this Project, as a timeline. */
export default async function ProjectActivityPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const found = await project(params);
  const activity = await attempt(
    read({ action: "activity", project: found.name }),
  );
  if (!activity.ok) return <Failure failure={activity.failure} />;
  return (
    <ActivityTimeline
      operations={(activity.value as ActivityResult).operations}
      showProject={false}
      now={Date.now()}
    />
  );
}

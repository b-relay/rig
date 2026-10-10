import { attempt } from "@/lib/outcome";
import type { ActivityResult } from "@/lib/types";
import { read } from "@/server/daemon";
import { project } from "@/server/project";
import { ActivityTable } from "@/components/activity-table";
import { Failure } from "@/components/bits";

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
    <ActivityTable
      operations={(activity.value as ActivityResult).operations}
      showProject={false}
    />
  );
}

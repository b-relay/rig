import { targetKey } from "@/lib/target";
import { firstLogPage, logTargets } from "@/server/logs";
import { target } from "@/server/target";
import { LogViewer } from "@/components/log-viewer";

/** This Target's log, streamed while following, narrowed by component and stream. */
export default async function TargetLogsPage({
  params,
}: {
  params: Promise<{ name: string; target: string }>;
}) {
  const { project, target: report } = await target(params);
  const [shown] = logTargets([report]);
  return (
    <LogViewer
      project={project.name}
      targets={shown ? [shown] : []}
      selected={targetKey(report)}
      first={await firstLogPage(project.name, report)}
      pickTarget={false}
    />
  );
}

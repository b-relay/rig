import { targetKey } from "@/lib/target";
import { project } from "@/server/project";
import { projectStatus } from "@/server/status";
import { firstLogPage, logTargets } from "@/server/logs";
import { Failure } from "@/components/bits";
import { LogViewer } from "@/components/log-viewer";

/** Any of the Project's Targets' logs, chosen with the picker; `?target=` keeps the choice. */
export default async function LogsPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ target?: string }>;
}) {
  const [found, { target: selected }] = await Promise.all([
    project(params),
    searchParams,
  ]);
  const status = await projectStatus(found.name);
  if (!status.ok) return <Failure failure={status.failure} />;
  const targets = logTargets(status.value.targets);
  const target =
    targets.find((each) => targetKey(each) === selected) ?? targets[0];
  return (
    <LogViewer
      project={found.name}
      targets={targets}
      selected={target ? targetKey(target) : undefined}
      first={await firstLogPage(found.name, target)}
    />
  );
}

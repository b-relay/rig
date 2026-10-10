import { attempt } from "@/lib/outcome";
import { targetKey, targetSelector } from "@/lib/target";
import type { LogsResult, ProjectStatusReport } from "@/lib/types";
import { read } from "@/server/daemon";
import { project } from "@/server/project";
import { Failure } from "@/components/bits";
import { LogsFollower } from "@/components/logs-follower";

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
  const status = await attempt(read({ action: "status", project: found.name }));
  if (!status.ok) return <Failure failure={status.failure} />;
  const targets = (status.value as ProjectStatusReport).targets;
  const target =
    targets.find((each) => targetKey(each) === selected) ?? targets[0];
  const first = target
    ? await attempt(
        read({
          action: "logs",
          project: found.name,
          ...targetSelector(target),
          lines: 200,
        }),
      )
    : undefined;
  return (
    <LogsFollower
      project={found.name}
      targets={targets.map(({ name, kind }) => ({ name, kind }))}
      selected={target ? targetKey(target) : undefined}
      first={first?.ok ? (first.value as LogsResult) : undefined}
    />
  );
}

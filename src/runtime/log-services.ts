import { RigError } from "../domain/errors";
import type { LogFilter } from "../domain/log-filter";
import type { JobRecord, TargetRecord } from "../domain/runtime";

/** The component names a Target's log lines are recorded under: its Services, then its Tools (build and install output),
 * then its jobs, those of the job runs recorded for it included (a run a deploy dropped the job of goes on), then `setup`
 * (dependency installation and the shared build). A plan waiting to be restored by rollback counts too. */
export function logComponents(
  target: TargetRecord,
  records: readonly JobRecord[] = [],
): string[] {
  const plans = [
    target.plan,
    ...(target.recovery ? [target.recovery.plan] : []),
  ];
  const components = plans.flatMap((plan) => plan.components);
  const named = (kind: "managed" | "installed") =>
    components
      .filter((component) => component.kind === kind)
      .map((component) => component.name)
      .sort();
  const jobs = [
    ...plans.flatMap((plan) => (plan.jobs ?? []).map((job) => job.name)),
    ...records
      .filter((record) => record.target === target.id)
      .map((record) => record.job),
  ].sort();
  return [
    ...new Set([...named("managed"), ...named("installed"), ...jobs, "setup"]),
  ];
}

/** Fails USAGE, listing the names the Target has, when `filter` narrows to a component the Target does not have. */
export function assertLogServices(
  target: TargetRecord,
  filter: LogFilter | undefined,
  records?: readonly JobRecord[],
): void {
  const known = logComponents(target, records);
  const unknown = (filter?.services ?? []).filter(
    (name) => !known.includes(name),
  );
  if (!unknown.length) return;
  throw new RigError(
    "USAGE",
    `Target '${target.name}' has no Service, Tool or job named ${unknown.map((name) => `'${name}'`).join(", ")}.`,
    `Pass --service with one of: ${known.join(", ")}.`,
    { unknown, known },
  );
}

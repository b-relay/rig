import { RigError } from "../domain/errors";
import type { LogFilter } from "../domain/log-filter";
import type { TargetRecord } from "../domain/runtime";

/** The component names a Target's log lines are recorded under: its Services, then its Tools (build and install output),
 * then `setup` (dependency installation and the shared build). A plan waiting to be restored by rollback counts too. */
export function logComponents(target: TargetRecord): string[] {
  const components = [
    ...target.plan.components,
    ...(target.recovery?.plan.components ?? []),
  ];
  const named = (kind: "managed" | "installed") =>
    components
      .filter((component) => component.kind === kind)
      .map((component) => component.name)
      .sort();
  return [...new Set([...named("managed"), ...named("installed"), "setup"])];
}

/** Fails USAGE, listing the names the Target has, when `filter` narrows to a component the Target does not have. */
export function assertLogServices(
  target: TargetRecord,
  filter: LogFilter | undefined,
): void {
  const known = logComponents(target);
  const unknown = (filter?.services ?? []).filter(
    (name) => !known.includes(name),
  );
  if (!unknown.length) return;
  throw new RigError(
    "USAGE",
    `Target '${target.name}' has no Service or Tool named ${unknown.map((name) => `'${name}'`).join(", ")}.`,
    `Pass --service with one of: ${known.join(", ")}.`,
    { unknown, known },
  );
}

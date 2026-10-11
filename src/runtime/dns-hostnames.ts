import { bareHostname } from "../domain/managed-proxy";
import type { ServedHostname } from "../domain/dns-hostnames";
import type { RuntimeState } from "../domain/runtime";
import { plannedSites } from "./ports";

/** Pure: whether `hostname` is a public DNS name worth checking: not an IP address, not localhost. */
function publicName(hostname: string): boolean {
  return (
    hostname.includes(".") &&
    !/^[\d.]+$/.test(hostname) &&
    !hostname.includes(":") &&
    hostname !== "localhost" &&
    !hostname.endsWith(".localhost")
  );
}
/** Pure: every hostname a recorded Target serves (its domain, and every site its plan names), with the Project and Target
 * behind it, for the DNS hostname check (ADR 0018). */
export function targetHostnames(
  state: Pick<RuntimeState, "projects" | "targets">,
): ServedHostname[] {
  const served = new Map<string, ServedHostname["sources"][number][]>();
  for (const target of state.targets) {
    const project =
      state.projects.find((each) => each.id === target.projectId)?.name ??
      target.projectId;
    const names = new Set(
      [
        ...(target.plan.domain ? [target.plan.domain] : []),
        ...plannedSites(target.plan).map((site) => site.hostname),
      ]
        .map(bareHostname)
        .filter(publicName),
    );
    for (const hostname of names)
      served.set(hostname, [
        ...(served.get(hostname) ?? []),
        { kind: "target", project, target: target.name },
      ]);
  }
  return [...served].map(([hostname, sources]) => ({ hostname, sources }));
}

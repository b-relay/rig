import { resolve as resolvePath } from "node:path";
import { ConfigError } from "../config/errors";
import type {
  DnsRequest,
  ListResult,
  RuntimeCommand,
} from "../daemon/protocol";
import { DNS_REFUSALS, requestedDnsChange } from "../domain/dns-records";
import { RigError } from "../domain/errors";
import { rigCommand } from "../domain/rig-command";
import { readOnlyState, type RuntimeState } from "../domain/runtime";
import type { DnsWriteAction, RuntimeDependencies } from "./contracts";
import { hostDoctor, type DoctorReport } from "./doctor";
import { targetHostnames } from "./dns-hostnames";
import { boundedObservations } from "./bounded-observations";
import { HOST_SCOPE, dnsScope } from "./operation-locks";
import type { OperationCoordinator } from "./operation-coordinator";
import type { CommandContext } from "./command-execution";
import { observeTargets, type TargetReport } from "./status";
import { withdrawOrphanedRoutes } from "./orphan-routes";
import { selectActivity, usage, usageWindow } from "./project-reads";

/* The commands that act on the Host or read it whole, before any Project is selected. */

/** `rigd uninstall`'s preparation: refused at once while any Operation runs, then, holding the Host, refused while any
 * Target is in a transition, runs, or may still run a build; otherwise rigd refuses new work until it is cancelled. */
export async function prepareUninstall(
  { admission, deps }: Pick<CommandContext, "admission" | "deps">,
  coordinator: Pick<OperationCoordinator, "busy" | "prepareUninstall">,
): Promise<unknown> {
  // Refused rather than queued: waiting for the whole Host would hold every later operation, automatic restarts
  // included, behind whatever runs now, only to refuse once it ended with Targets still running.
  if (coordinator.busy(HOST_SCOPE))
    throw new RigError(
      "TARGETS_RUNNING",
      "Cannot uninstall rigd while operations are running.",
      "Wait for them to finish (rig activity shows them), stop all Targets, then retry.",
    );
  await admission.admit([HOST_SCOPE], {});
  const state = await deps.store.read();
  if (state.targets.some((t) => t.recovery || t.destructionPending))
    throw new RigError(
      "DEPLOY_RECOVERY",
      "Cannot uninstall rigd while Targets have unresolved recovery or destruction.",
      `Finish them first: ${state.targets
        .filter((t) => t.recovery || t.destructionPending)
        .map((t) =>
          rigCommand(
            "down",
            { target: t },
            ...(t.destructionPending ? ["--destroy"] : []),
          ),
        )
        .join(", ")}; then retry uninstall.`,
    );
  const reports = await observeTargets(
    state.targets,
    deps.observations,
    deps.observationBudgetMs,
    deps.observationDeadline,
    deps.healthResults,
  );
  const blocking = uninstallBlockers(state, reports);
  if (blocking.length)
    throw new RigError(
      "TARGETS_RUNNING",
      `Cannot uninstall rigd while Targets are running or uncertain: ${blocking.map(({ what }) => what).join("; ")}.`,
      `Stop them (${blocking.map(({ stop }) => stop).join(", ")}), check rig status, then retry. Only Services and job runs keep rigd from uninstalling: Tools stay installed, whatever state they are in.`,
    );
  // A build a daemon that died left running is in no Target's status: only its recorded process group shows it.
  const builds = await boundedObservations(
    state.targets.map(
      (target) => (signal: AbortSignal) =>
        deps.lifecycle.observePreparation(target, signal),
    ),
    deps.observationBudgetMs,
    deps.observationDeadline,
  );
  const buildingTargets = state.targets.filter(
    (_, index) =>
      builds[index]!.kind !== "completed" ||
      builds[index]!.value.state !== "stopped",
  );
  const building = buildingTargets.map(
    (target) =>
      `${state.projects.find((p) => p.id === target.projectId)?.name ?? target.projectId} ${target.name}`,
  );
  if (building.length)
    throw new RigError(
      "TARGETS_RUNNING",
      `Cannot uninstall rigd while a build an earlier rigd started may still run for ${building.join(", ")}.`,
      `Stop ${building.length === 1 ? "it" : "them"} with ${buildingTargets
        .map((target) => rigCommand("down", { target }))
        .join(", ")}, then retry.`,
      { targets: building },
    );
  coordinator.prepareUninstall();
  return { ready: true };
}
/** What keeps rigd from uninstalling, each with the command that stops it: a Target meant to run, a job run in progress, or
 * a Service whose process runs or cannot be ruled out. A Tool is an installed file and storage is data, and both outlive
 * rigd, so neither counts in any state. `reports` follow `state.targets`. A job run whose Target is no longer recorded
 * counts too, with nothing to stop it through but what status shows of it. */
function uninstallBlockers(
  state: Pick<RuntimeState, "targets" | "projects" | "jobs">,
  reports: readonly TargetReport[],
): { what: string; stop: string }[] {
  const unrecorded = (state.jobs ?? [])
    .filter(
      (record) =>
        record.running &&
        !state.targets.some((target) => target.id === record.target),
    )
    .map((record) => ({
      what: `job ${record.job} of a Target no longer recorded is running`,
      stop: "rig status",
    }));
  const recorded = state.targets.flatMap((target, index) => {
    const named = `${state.projects.find((project) => project.id === target.projectId)?.name ?? target.projectId} ${target.name}`;
    const services = reports[index]!.components.filter(
      (component) =>
        component.kind === "managed" &&
        ["running", "healthy", "unhealthy", "unknown"].includes(
          component.state,
        ),
    ).map((component) => `${component.name} is ${component.state}`);
    const jobs = (state.jobs ?? [])
      .filter((record) => record.target === target.id && record.running)
      .map((record) => `job ${record.job} is running`);
    const reasons = [
      ...services,
      ...jobs,
      ...(target.desired === "running" && !services.length
        ? ["it is meant to run"]
        : []),
    ];
    return reasons.length
      ? [
          {
            what: `${named} (${reasons.join(", ")})`,
            stop: rigCommand("down", { target }),
          },
        ]
      : [];
  });
  return [...recorded, ...unrecorded];
}
/** `rig proxy reload`. A route block whose Target is gone is withdrawn first, so a reload is the way to clear one without
 * restarting rigd, and Host config whose proxy.routes names that hostname is not refused because of it. This is the
 * explicit sweep: it runs even where the route file lies outside the Rig root. Publication runs in the router's own
 * queue, so it never interleaves with a route change; no Target scope is held. */
export async function applyProxy(deps: RuntimeDependencies): Promise<unknown> {
  const withdrawn = await withdrawOrphanedRoutes(deps, false);
  // Without Rig's own Caddy there is no proxy section to apply: the reload only withdraws.
  if (!deps.proxy) return { outcome: "withdrawn", withdrawn };
  await deps.proxy.apply();
  return {
    outcome: "applied",
    ...(withdrawn.length ? { withdrawn } : {}),
  };
}
/** `rig proxy`: what Rig's own Caddy serves. */
export async function proxyReport(
  deps: Pick<RuntimeDependencies, "proxy" | "store">,
): Promise<unknown> {
  if (!deps.proxy)
    throw new RigError(
      "PROXY_UNMANAGED",
      "Rig does not run its own Caddy on this Host.",
      "Add a proxy section to config.yaml under the Rig root and run rigd install (rig-guide: Rig's own Caddy).",
    );
  const state = await deps.store.read();
  return deps.proxy.report(
    state.targets.map((target) => ({
      id: target.id,
      name: target.name,
      project:
        state.projects.find((p) => p.id === target.projectId)?.name ??
        target.projectId,
    })),
  );
}
/** `rig dns`: a read of the zones, or one write, which runs while no other change of its zone does. */
export async function dnsCommand(
  action: "dns" | DnsWriteAction,
  request: DnsRequest,
  { admission, deps, outcome }: CommandContext,
): Promise<unknown> {
  if (!deps.dns)
    throw new RigError(
      "DNS_UNAVAILABLE",
      "This rigd does not manage DNS records.",
      "Run rigd install from this version of Rig.",
    );
  if (action === "dns")
    return await deps.dns.read({
      ...(request.zone !== undefined ? { zone: request.zone } : {}),
      hostnames: targetHostnames(await deps.store.read()),
    });
  // Changes of one zone run one at a time, so each re-reads what it changes with no other change of Rig's between.
  await admission.admit([dnsScope(request.zone ?? "")], {});
  // From here a failure is an Operation in Activity, provider failures before the write included; a request that is
  // malformed or names a stale record is refused as a usage mistake, as other commands' are.
  outcome.note = requestedDnsChange(action, request);
  outcome.attempted = true;
  const write = await deps.dns
    .prepare(action, request)
    .catch((error: unknown) => {
      if (error instanceof RigError && DNS_REFUSALS.has(error.code))
        outcome.attempted = false;
      throw error;
    });
  outcome.note = write.change;
  const record = await write.apply();
  return await outcome.finish("updated", {
    zone: write.zone,
    summary: write.summary,
    ...(record ? { record } : {}),
  });
}
/** `rig list`: the inventory as recorded. Target liveness is status's job and is not observed here, and each Project's
 * config is not read either. */
export async function listProjects(
  deps: Pick<RuntimeDependencies, "store" | "documents">,
): Promise<ListResult> {
  const state = await readOnlyState(deps.store);
  const targetCounts = new Map<string, number>();
  for (const target of state.targets)
    targetCounts.set(
      target.projectId,
      (targetCounts.get(target.projectId) ?? 0) + 1,
    );
  return {
    projects: await Promise.all(
      state.projects.map(async (p) => ({
        id: p.id,
        name: p.name,
        repoPath: p.repoPath,
        targetCount: targetCounts.get(p.id) ?? 0,
        ...((await deps.documents.directoryMissing(p.repoPath))
          ? { missing: true }
          : {}),
      })),
    ),
  } satisfies ListResult;
}
/** Monitor's history of the whole Host. */
export async function hostUsage(
  command: RuntimeCommand,
  deps: Pick<RuntimeDependencies, "usage" | "now">,
): Promise<unknown> {
  return await usage(deps).report({
    filter: { kind: "host" },
    window: usageWindow(command, deps.now()),
  });
}
/** Every Project's Activity with rigd's own administration. */
export async function hostActivity(
  command: RuntimeCommand,
  deps: Pick<RuntimeDependencies, "store" | "readAdminActivity">,
): Promise<unknown> {
  const [state, admin] = await Promise.all([
    deps.store.read(),
    deps.readAdminActivity(),
  ]);
  return selectActivity(
    [...state.activity, ...admin].sort((a, b) =>
      a.occurredAt.localeCompare(b.occurredAt),
    ),
    command,
  );
}
/** What `rig init` would record for the directory `command.repoPath`. */
export async function initializationInfo(
  command: RuntimeCommand,
  deps: Pick<RuntimeDependencies, "documents">,
): Promise<unknown> {
  if (!command.repoPath)
    throw new RigError(
      "PATH_REQUIRED",
      "A Project directory is required.",
      "Run init from the Project directory.",
    );
  return await deps.documents.initializationInfo(command.repoPath);
}
/** `rig doctor` with no Project named: the Host checks alone, with the reason Project checks are absent, unless the
 * directory it runs in names a registered Project, which is checked as if named (undefined). */
export async function unregisteredDoctor(
  command: RuntimeCommand,
  deps: RuntimeDependencies,
): Promise<DoctorReport | undefined> {
  try {
    if (!command.repoPath)
      throw new ConfigError(
        "No Project selected.",
        "missing_config",
        {},
        "Run rig doctor in a Project repository, or pass --project <name>, to check that Project too.",
      );
    const found = await deps.documents.discover(command.repoPath);
    const state = await deps.store.read();
    // A directory whose config names no registered Project still gets Host checks, with the reason Project checks are absent.
    if (
      !state.projects.some(
        (p) =>
          p.name === found.document.config.name ||
          resolvePath(p.repoPath) === resolvePath(found.repoPath),
      )
    )
      throw new RigError(
        "PROJECT_MISSING",
        `Project '${found.document.config.name}' is not registered.`,
        "Run rig init in this Project directory.",
      );
  } catch (error) {
    return await hostDoctor(deps, error);
  }
  return undefined;
}

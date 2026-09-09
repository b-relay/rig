import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type {
  ProjectRecord,
  RuntimeState,
  TargetRecord,
} from "../domain/runtime";
import type { PlanComponent, TargetPlan } from "../config/types";
import { runtimeStateSchema, targetPlanSchema } from "../runtime/state-schema";
import type { LegacyRecord, LegacyRegistry, LegacyState } from "./schema";
import type {
  MigrationIssue,
  MigrationPreview,
  ProcessAdoption,
  RouteAdoption,
} from "./types";
const id = (kind: string, value: string) =>
  `legacy-${kind}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
interface ConversionInput {
  legacy: LegacyState;
  registry: LegacyRegistry;
  inventories: LegacyRecord[];
}
/** Pure conversion of recorded evidence. Today's Project config never fills missing recorded policy. */
export function convertLegacyState({
  legacy,
  registry,
  inventories,
}: ConversionInput): Omit<MigrationPreview, "revision" | "files"> {
  const issues: MigrationIssue[] = [],
    projects = resolveProjects(legacy, registry, issues),
    targets: TargetRecord[] = [];
  const records = new Map<string, LegacyRecord>();
  for (const desired of legacy.desiredDeployments) {
    const key = `${desired.project}:${desired.deployment}`;
    if (records.has(key))
      issues.push({
        code: "duplicate_target",
        message: "More than one desired record names this Target.",
        project: desired.project,
        target: desired.deployment,
      });
    records.set(key, desired.record);
  }
  for (const record of inventories) {
    const key = `${record.project}:${record.name}`;
    const current = records.get(key);
    if (current && !isDeepStrictEqual(current, record))
      issues.push({
        code: "conflicting_target",
        message:
          "Inventory and desired deployment disagree about recorded policy.",
        project: record.project,
        target: record.name,
      });
    else if (!current)
      issues.push({
        code: "missing_desired_state",
        message:
          "A materialized inventory Target has no recorded desired state.",
        project: record.project,
        target: record.name,
      });
  }
  for (const desired of legacy.desiredDeployments) {
    const record = desired.record,
      project = projects.find((project) => project.name === desired.project);
    if (!project) {
      issues.push({
        code: "missing_project",
        message: "Target has no unambiguous Project registration.",
        project: desired.project,
        target: desired.deployment,
      });
      continue;
    }
    if (
      record.project !== desired.project ||
      record.name !== desired.deployment ||
      record.kind !== desired.kind
    ) {
      issues.push({
        code: "identity_conflict",
        message: "Target identity disagrees with its deployment record.",
        project: desired.project,
        target: desired.deployment,
      });
      continue;
    }
    if (
      record.kind !== "local" &&
      (!record.sourceRef || !record.sourceCommit)
    ) {
      issues.push({
        code: "missing_deployed_ref",
        message:
          "The recorded materialized Target lacks its deployed Branch or Commit; current config cannot recover it.",
        project: record.project,
        target: record.name,
      });
    }
    const plan = convertPlan(record, issues);
    if (!plan) continue;
    targets.push({
      id: id("target", `${project.id}:${record.name}`),
      projectId: project.id,
      name: record.name,
      kind: plan.target,
      ...(record.sourceRef ? { branch: record.sourceRef } : {}),
      ...(record.sourceCommit ? { commit: record.sourceCommit } : {}),
      plan,
      desired: desired.desiredStatus === "stopped" ? "stopped" : "running",
      createdAt: desired.updatedAt,
      updatedAt: desired.updatedAt,
      logRoot: record.logRoot,
    });
  }
  const state: RuntimeState = { version: 2, projects, targets, activity: [] };
  const checked = runtimeStateSchema.safeParse(state);
  if (!checked.success)
    issues.push({
      code: "invalid_converted_state",
      message:
        "Converted runtime state does not satisfy identity or dependency invariants.",
    });
  const adoption = planAdoption(targets, projects);
  return {
    projects: projects.map(({ name, repoPath, configPath }) => ({
      name,
      repoPath,
      configPath,
    })),
    targets: legacy.desiredDeployments.map((desired) => ({
      project: desired.project,
      name: desired.deployment,
      kind: desired.kind,
      workspacePath: desired.record.workspacePath,
      desired: desired.desiredStatus,
    })),
    issues,
    warnings: [],
    recoveredSources: [],
    ...(!issues.length ? { state } : {}),
    adoption,
    history: {
      events: legacy.events.length,
      acceptedReceipts: legacy.receipts.length,
      failures: legacy.managedServiceFailures.length,
      preservation: "original-files-and-exact-backups",
    },
  };
}
function resolveProjects(
  legacy: LegacyState,
  registry: LegacyRegistry,
  issues: MigrationIssue[],
): ProjectRecord[] {
  const projects = new Map<string, ProjectRecord>();
  const register = (
    name: string,
    repoPath: string,
    configPath: string,
    createdAt: string,
  ) => {
    const existing = projects.get(name);
    if (
      existing &&
      (resolve(existing.repoPath) !== resolve(repoPath) ||
        resolve(existing.configPath) !== resolve(configPath))
    ) {
      issues.push({
        code: "registration_conflict",
        message:
          "Recorded registrations disagree about the current Project path.",
        project: name,
      });
      return;
    }
    projects.set(name, {
      id: id("project", name),
      name,
      repoPath,
      configPath,
      createdAt: existing?.createdAt ?? createdAt,
    });
  };
  for (const [name, entry] of Object.entries(registry))
    register(
      name,
      entry.repoPath,
      join(entry.repoPath, "rig.json"),
      entry.registeredAt,
    );
  for (const event of legacy.events)
    if (
      ["rigd.project.registered", "rigd.project.initialized"].includes(
        event.event,
      )
    ) {
      const repoPath = event.details?.repoPath,
        configPath = event.details?.configPath;
      if (
        !event.project ||
        typeof repoPath !== "string" ||
        !isAbsolute(repoPath) ||
        typeof configPath !== "string" ||
        !isAbsolute(configPath)
      ) {
        issues.push({
          code: "incomplete_registration",
          message: "A Project registration lacks authoritative source paths.",
          ...(event.project ? { project: event.project } : {}),
        });
        continue;
      }
      register(event.project, repoPath, configPath, event.timestamp);
    }
  return [...projects.values()];
}
function convertPlan(
  record: LegacyRecord,
  issues: MigrationIssue[],
): TargetPlan | undefined {
  const old = record.resolved.runtimePlan,
    target = record.kind === "generated" ? "preview" : record.kind;
  const complain = (message: string) =>
    issues.push({
      code: "invalid_recorded_plan",
      message,
      project: record.project,
      target: record.name,
    });
  if (
    old.project !== record.project ||
    old.deploymentName !== record.name ||
    old.workspacePath !== record.workspacePath ||
    old.dataRoot !== record.dataRoot ||
    old.lane !== (target === "preview" ? "deployment" : target)
  ) {
    complain(
      "The recorded runtime plan disagrees with deployment identity or paths.",
    );
    return;
  }
  if (
    record.resolved.project !== record.project ||
    record.resolved.deploymentName !== record.name ||
    record.resolved.workspacePath !== record.workspacePath ||
    record.resolved.dataRoot !== record.dataRoot ||
    record.resolved.lane !== old.lane ||
    record.resolved.providers.processSupervisor !==
      old.providers.processSupervisor ||
    record.providerProfile !== old.providerProfile ||
    record.resolved.providerProfile !== old.providerProfile
  ) {
    complain(
      "Recorded provider, identity, or path selections conflict across the deployment snapshot.",
    );
    return;
  }
  const components: PlanComponent[] = old.components.map((component) => {
    const common = {
      ...component,
      env: component.env ?? {},
      dependsOn:
        component.kind === "managed" ? (component.dependsOn ?? []) : [],
      ...(component.envFile
        ? { envFile: resolve(record.workspacePath, component.envFile) }
        : {}),
    };
    return component.kind === "installed"
      ? {
          ...common,
          kind: "installed",
          entrypoint: resolve(record.workspacePath, component.entrypoint),
          ...(component.build ? { build: component.build } : {}),
          ...(component.installName
            ? { installName: component.installName }
            : {}),
        }
      : {
          ...common,
          kind: "managed",
          command: component.command,
          port: component.port,
          readyTimeout: component.readyTimeout,
          ...(component.health ? { health: component.health } : {}),
        };
  });
  for (const prepared of old.preparedComponents)
    if (prepared.uses === "sqlite") {
      if (components.some((component) => component.name === prepared.name)) {
        complain("Prepared SQLite identity conflicts with another Component.");
        return;
      }
      components.unshift({
        name: prepared.name,
        kind: "persistent",
        uses: "sqlite",
        path: prepared.path,
        env: {},
        dependsOn: [],
      });
    }
  const ordered = orderComponents(components);
  if (!ordered) {
    complain("Recorded dependencies are missing or cyclic.");
    return;
  }
  const plan: TargetPlan = {
    project: record.project,
    target,
    deploymentName: record.name,
    branchSlug: old.branchSlug,
    subdomain: old.subdomain,
    workspacePath: record.workspacePath,
    dataRoot: record.dataRoot,
    providers: old.providers,
    providerProfile: old.providerProfile,
    components: ordered,
    preparedComponents: old.preparedComponents,
    ...(record.sourceRef ? { branch: record.sourceRef } : {}),
    ...(record.sourceCommit ? { commit: record.sourceCommit } : {}),
    ...(old.domain ? { domain: old.domain } : {}),
    ...(old.proxy ? { proxy: old.proxy } : {}),
    ...(old.hooks ? { hooks: old.hooks } : {}),
    ...(old.envFile
      ? { envFile: resolve(record.workspacePath, old.envFile) }
      : {}),
    ...(record.resolved.v1Config.daemon
      ? { daemon: record.resolved.v1Config.daemon }
      : {}),
  };
  if (!targetPlanSchema.safeParse(plan).success) {
    complain("The recorded runtime plan is incomplete.");
    return;
  }
  return plan;
}
function orderComponents(
  components: PlanComponent[],
): PlanComponent[] | undefined {
  const byName = new Map(
      components.map((component) => [component.name, component]),
    ),
    active = new Set<string>(),
    done = new Set<string>(),
    result: PlanComponent[] = [];
  if (byName.size !== components.length) return undefined;
  const visit = (name: string): boolean => {
    if (active.has(name) || !byName.has(name)) return false;
    if (done.has(name)) return true;
    active.add(name);
    const component = byName.get(name)!;
    for (const dependency of component.dependsOn)
      if (!visit(dependency)) return false;
    active.delete(name);
    done.add(name);
    result.push(component);
    return true;
  };
  return components.every((component) => visit(component.name))
    ? result
    : undefined;
}
function planAdoption(
  targets: TargetRecord[],
  projects: ProjectRecord[],
): { processes: ProcessAdoption[]; routes: RouteAdoption[] } {
  const processes: ProcessAdoption[] = [],
    routes: RouteAdoption[] = [];
  const labelPart = (value: string) =>
    value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "component";
  for (const target of targets) {
    const project = projects.find(
      (project) => project.id === target.projectId,
    )!;
    for (const component of target.plan.components)
      if (component.kind === "managed") {
        const provider = target.plan.providers.processSupervisor;
        processes.push({
          project: project.name,
          target: target.name,
          component: component.name,
          key: `${target.id}:${component.name}`,
          provider,
          ...(provider === "launchd"
            ? {
                legacyLabel: [
                  "com.b-relay.rig",
                  project.name,
                  target.name,
                  component.name,
                ]
                  .map(labelPart)
                  .join("."),
              }
            : {}),
          status: "requires-adoption",
          reason:
            provider === "launchd"
              ? "Verify and explicitly adopt or replace the existing launchd job before runtime control."
              : "Legacy direct-process handles were not durably recorded; verify process absence or perform an explicit supervised cutover.",
        });
        if (
          target.plan.proxy?.upstream === component.name &&
          target.plan.domain
        )
          routes.push({
            project: project.name,
            target: target.name,
            component: component.name,
            key: target.id,
            legacyMarker: `# [rig:${project.name}:${target.name}:${component.name}]`,
            hostname: target.plan.domain,
            upstream: `127.0.0.1:${component.port}`,
            status: "requires-adoption",
          });
      }
  }
  return { processes, routes };
}

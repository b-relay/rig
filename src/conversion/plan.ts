import { isAbsolute, relative } from "node:path";
import type { HookDecision, Review } from "./review";
import type { LegacyComponent, LegacyTarget } from "./legacy-state";

/** Why a conversion cannot be applied. `subject` is what the operator has to look at; never a value from an env file. */
export interface Blocker {
  code: string;
  project: string;
  target?: string;
  subject?: string;
  message: string;
}
/** What one saved Target becomes, in reviewable terms. */
export interface TargetMapping {
  project: string;
  id: string;
  name: string;
  kind: "local" | "live" | "preview";
  branch?: string;
  commit?: string;
  dataRoot: string;
  logRoot: string;
  workspacePath: string;
  builds: { id: string; from: string; timeout: number }[];
  hooks: { subject: string; decision: HookDecision }[];
  envFiles: { component: string; path: string; insideWorkspace: boolean }[];
  restart?: "no";
  /** `saved-plan`: the new runtime can start it as converted. `needs-deploy`: only a new Deployment can run.
   * `working-copy`: planned again from rig.yaml at every start. */
  start: "saved-plan" | "needs-deploy" | "working-copy";
  reasons: string[];
}
export interface TargetConversion {
  /** The record for the new state file; present even when blocked, so a preview shows the whole mapping. */
  target: Record<string, unknown>;
  mapping: TargetMapping;
  blockers: Blocker[];
  warnings: string[];
}
const PLAN_KEYS = new Set([
  "project",
  "target",
  "workspacePath",
  "dataRoot",
  "deploymentName",
  "branchSlug",
  "subdomain",
  "branch",
  "commit",
  "providers",
  "providerProfile",
  "env",
  "daemon",
  "components",
  "preparedComponents",
  "domain",
  "proxy",
  "hooks",
  "hookTimeout",
  "installTimeout",
  "envFile",
]);
const COMPONENT_KEYS = new Set([
  "name",
  "kind",
  "env",
  "dependsOn",
  "hooks",
  "hookTimeout",
  "envFile",
  "port",
  "command",
  "readyTimeout",
  "health",
  "sitePort",
  "entrypoint",
  "installName",
  "build",
  "buildTimeout",
  "uses",
  "path",
]);
const TARGET_KEYS = new Set([
  "id",
  "projectId",
  "name",
  "kind",
  "branch",
  "commit",
  "plan",
  "desired",
  "createdAt",
  "updatedAt",
  "logRoot",
  "sourceRoot",
  "destructionPending",
  "deploymentIncomplete",
  "recovery",
]);
/** The retired runtime's defaults, made explicit so the converted plan does not pick up a different one. */
const OLD_HOOK_TIMEOUT = 120,
  OLD_BUILD_TIMEOUT = 600;
/** Inherited names the retired runtime passed to every command and the new execution baseline does not. */
const DROPPED_AMBIENT = ["USER", "LOGNAME", "SHELL"] as const;

/** Pure mapping of one saved Target of the retired runtime to a record of the new one. It invents no outcome: the result
 * carries no `preparation` and no `services`, keeps identity, data, log and source paths as they are, and leaves `desired`
 * untouched. Everything it cannot map faithfully comes back as a blocker; everything the converted plan cannot reproduce
 * without a new Deployment comes back as `needs-deploy` with its reasons. */
export function convertTarget(
  legacy: LegacyTarget,
  review: Review,
): TargetConversion {
  const plan = legacy.plan,
    project = plan.project,
    deployed = legacy.kind !== "local",
    blockers: Blocker[] = [],
    warnings: string[] = [],
    reasons: string[] = [];
  const block = (code: string, message: string, subject?: string) =>
    blockers.push({
      code,
      project,
      target: legacy.name,
      ...(subject ? { subject } : {}),
      message,
    });
  for (const key of Object.keys(legacy))
    if (!TARGET_KEYS.has(key))
      block(
        "unsupported_mapping",
        `The saved Target carries ${key}, which this conversion does not know how to keep.`,
        key,
      );
  for (const key of Object.keys(plan))
    if (!PLAN_KEYS.has(key))
      block(
        "unsupported_mapping",
        `The saved plan carries ${key}, which this conversion does not know how to keep.`,
        `plan.${key}`,
      );
  if (legacy.desired !== "stopped")
    block(
      "target_running",
      `${project}/${legacy.name} is recorded as running. Stop it with the runtime that started it (rig down) before converting.`,
    );
  if (legacy.recovery !== undefined)
    block(
      "unresolved_recovery",
      `${project}/${legacy.name} has an unresolved deployment transition. Settle it with the runtime that recorded it (rig down) before converting.`,
    );
  if (legacy.deploymentIncomplete)
    block(
      "incomplete_deployment",
      `${project}/${legacy.name} has a deployment that never completed. Finish or redeploy it with the runtime that recorded it before converting.`,
    );
  if (legacy.destructionPending)
    block(
      "destruction_pending",
      `${project}/${legacy.name} is a Preview whose destruction is pending. Finish it with the runtime that recorded it before converting.`,
    );

  const builds: Record<string, unknown>[] = [],
    mapping: TargetMapping = {
      project,
      id: legacy.id,
      name: legacy.name,
      kind: legacy.kind,
      ...(legacy.branch ? { branch: legacy.branch } : {}),
      ...(legacy.commit ? { commit: legacy.commit } : {}),
      dataRoot: plan.dataRoot,
      logRoot: legacy.logRoot,
      workspacePath: plan.workspacePath,
      builds: [],
      hooks: [],
      envFiles: [],
      start: deployed ? "saved-plan" : "working-copy",
      reasons,
    };
  /** Every hook is decided on its own; the converted plan never carries one. */
  const decideHooks = (
    owner: LegacyComponent | undefined,
    hooks: Record<string, string | undefined> | undefined,
    timeout: number,
  ) => {
    for (const [hook, command] of Object.entries(hooks ?? {})) {
      if (command === undefined) continue;
      const subject = `${project}/${owner?.name ?? "@project"}/${hook}`,
        decision = review.hooks[subject];
      if (!decision) {
        block(
          "unmapped_hook",
          `The ${hook} hook ${subject} has no reviewed decision. Rig has no hooks any more: decide in the review whether it is a build or what replaces it.`,
          subject,
        );
        continue;
      }
      mapping.hooks.push({ subject, decision });
      if (decision.as === "replaced") {
        if (deployed)
          reasons.push(
            `the ${hook} hook of ${owner?.name ?? "the Project"} no longer runs (replaced by: ${decision.by})`,
          );
        continue;
      }
      if (hook !== "preStart" || owner?.kind !== "managed") {
        block(
          "unsupported_hook_mapping",
          `${subject} cannot be a build: only the preStart hook of a managed Component runs where a Service build runs.`,
          subject,
        );
        continue;
      }
      const id = `service:${owner.name}`;
      builds.push({ id, component: owner.name, command, timeout });
      mapping.builds.push({ id, from: `hooks.${hook}`, timeout });
    }
  };
  const ambient = (text: string | undefined, subject: string) => {
    for (const name of DROPPED_AMBIENT)
      if (
        text !== undefined &&
        new RegExp(`\\$(?:${name}\\b|\\{${name}\\b)`).test(text) &&
        !review.ambient.includes(name)
      )
        block(
          "ambient_name",
          `${subject} names $${name}, which the retired runtime inherited from the daemon and the new one does not pass. Set it in env, or list ${name} under ambient in the review to accept that it is unset.`,
          subject,
        );
  };

  decideHooks(undefined, plan.hooks, plan.hookTimeout ?? OLD_HOOK_TIMEOUT);
  const components = plan.components.map((component) => {
    const at = `${project}/${component.name}`;
    for (const key of Object.keys(component))
      if (!COMPONENT_KEYS.has(key))
        block(
          "unsupported_mapping",
          `The saved Component ${at} carries ${key}, which this conversion does not know how to keep.`,
          `${at}.${key}`,
        );
    decideHooks(
      component,
      component.hooks,
      component.hookTimeout ?? plan.hookTimeout ?? OLD_HOOK_TIMEOUT,
    );
    ambient(component.command, `${at} command`);
    ambient(component.build, `${at} build`);
    for (const [hook, command] of Object.entries(component.hooks ?? {}))
      ambient(command, `${at}/${hook}`);
    if (component.kind === "installed" && component.build) {
      const id = `tool:${component.name}`,
        timeout = component.buildTimeout ?? OLD_BUILD_TIMEOUT;
      if (builds.some((unit) => unit.id === id))
        block("unsupported_mapping", `${at} would have two builds.`, at);
      builds.push({
        id,
        component: component.name,
        command: component.build,
        timeout,
      });
      mapping.builds.push({ id, from: "build", timeout });
    }
    const envFile = component.envFile ?? plan.envFile;
    if (envFile !== undefined) {
      const inside = within(plan.workspacePath, envFile);
      mapping.envFiles.push({
        component: component.name,
        path: envFile,
        insideWorkspace: inside,
      });
      if (deployed && inside)
        reasons.push(
          `the env file of ${component.name} is part of the checked-out Commit, which the new runtime refuses to load`,
        );
      // A file outside the Commit still loads. Which names it sets is not known, because it is never opened: any env next to it may now lose.
      const names = Object.keys({ ...plan.env, ...component.env });
      if (names.length) {
        const flipped = `${component.name} sets env (${names.join(", ")}) next to the env file ${envFile}: a name in both now takes the file's value, where the retired runtime let env win`;
        if (deployed && !inside) reasons.push(flipped);
        else if (!deployed)
          warnings.push(`${project}/${legacy.name}: ${flipped}`);
      }
    }
    const {
      envFile: _envFile,
      hooks: _hooks,
      hookTimeout: _hookTimeout,
      build: _build,
      buildTimeout: _buildTimeout,
      ...kept
    } = component;
    return {
      ...kept,
      // The retired runtime layered lane env under Component env; the new one reads only the Component's own.
      env: { ...plan.env, ...component.env },
      ...(envFile !== undefined
        ? { envFiles: [{ path: envFile, required: true }] }
        : {}),
      ...(component.kind === "managed" && plan.daemon?.keepAlive === false
        ? { restart: "no" }
        : {}),
    };
  });
  for (const [hook, command] of Object.entries(plan.hooks ?? {}))
    ambient(command, `${project}/@project/${hook}`);
  if (plan.daemon?.keepAlive === false) mapping.restart = "no";
  if (deployed)
    for (const unit of mapping.builds)
      reasons.push(
        `${unit.id} never ran as a build, and no build success is invented for it`,
      );
  if (deployed && reasons.length) mapping.start = "needs-deploy";
  if (plan.installTimeout !== undefined)
    warnings.push(
      `${project}/${legacy.name}: installTimeout ${plan.installTimeout}s stays in the saved plan; rig.yaml has no field for it, so a new Deployment uses the default.`,
    );

  const {
    envFile: _envFile,
    hooks: _hooks,
    hookTimeout: _hookTimeout,
    ...keptPlan
  } = plan;
  return {
    target: {
      ...legacy,
      plan: {
        ...keptPlan,
        components,
        ...(builds.length ? { builds } : {}),
      },
      ...(mapping.start === "needs-deploy"
        ? { conversion: { needsDeploy: reasons } }
        : {}),
    },
    mapping,
    blockers,
    warnings,
  };
}
function within(directory: string, path: string): boolean {
  const inside = relative(directory, path);
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

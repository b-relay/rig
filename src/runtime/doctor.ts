import { isDeepStrictEqual } from "node:util";
import type { ProjectRecord, TargetRecord } from "../domain/runtime";
import { shellWord } from "../domain/target-selector";
import {
  MAX_NAME_LENGTH,
  caseVariantOf,
  nameKey,
  nameProblem,
  reservedPreviewName,
} from "../domain/names";
import type { ConfigDocument, ProjectConfig } from "../config/types";
import type { OrphanedTool, RuntimeDependencies } from "./contracts";
import { join } from "node:path";
import { RigError } from "../domain/errors";
import { observeTargets, OBSERVATION_EXPIRED } from "./status";
import { pendingRenameAdvice } from "./rename";
import type { ComponentReport } from "../domain/project-status";
import type { DoctorCheck } from "../daemon/offline-doctor";
import { ConfigError } from "../config/errors";
import { targetOn, usesRenamedKeys } from "../config/schema";
import {
  formerName,
  reservedBecause,
  roleLabel,
  turnOnInstruction,
} from "./targets";
import { withPlanDefaults, withValuesWritten } from "../config/plan-defaults";
import { replannedPolicy } from "./plan-drift";
import { plannedSites } from "./ports";
import { routeOwnerToken } from "../domain/proxy-publication";
import { transitionInProgress } from "./project-status";
import { rigCommand } from "../domain/rig-command";
import {
  identityDriftHint,
  movedProject,
  registeredDirectoryMissing,
} from "./projects";

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  /** The Project whose checks the report includes; absent when only the Host was checked. */
  project?: string;
  /** Why Project checks are absent, so a clean Host report is not read as a clean Project. */
  note?: string;
}
/** Host checks and ownership evidence remain available when Project discovery fails;
 * the report says why Project checks were skipped instead of implying they passed. */
export async function hostDoctor(
  deps: RuntimeDependencies,
  discoveryFailure?: unknown,
): Promise<DoctorReport> {
  const checks = await inspectRuntimeHost(deps);
  const skipped = (why: string) => `Project checks were skipped: ${why}`;
  let note = skipped("no Project selected.");
  if (
    discoveryFailure instanceof RigError &&
    discoveryFailure.code === "PROJECT_MISSING"
  )
    note = skipped(`${discoveryFailure.message} ${discoveryFailure.hint}`);
  else if (
    discoveryFailure !== undefined &&
    !(
      discoveryFailure instanceof ConfigError &&
      discoveryFailure.code === "missing_config"
    )
  ) {
    note = skipped("the Project config could not be read.");
    checks.push({
      name: "project-config",
      ok: false,
      message:
        discoveryFailure instanceof ConfigError
          ? discoveryFailure.message
          : "Project discovery failed.",
      reason: "config-invalid",
      hint:
        discoveryFailure instanceof ConfigError
          ? discoveryFailure.hint
          : "Inspect the Project directory.",
    });
  }
  return { ok: checks.every((check) => check.ok), checks, note };
}

async function inspectRuntimeHost(
  deps: Pick<
    RuntimeDependencies,
    | "inspectHost"
    | "inspectProxy"
    | "routeFileInRoot"
    | "orphanedTools"
    | "store"
    | "notices"
    | "root"
  >,
) {
  const checks = await deps.inspectHost();
  const orphans = await orphanedRoutesCheck(deps);
  if (orphans) checks.push(orphans);
  const tools = await orphanedToolsCheck(deps);
  if (tools) checks.push(tools);
  const names = await projectNamesCheck(deps);
  if (names) checks.push(names);
  checks.unshift({ name: "rigd", ok: true, message: "Daemon is reachable." });
  for (const notice of deps.notices?.() ?? [])
    checks.push({
      name: `rigd/${notice.channel}`,
      ok: false,
      message: `${notice.message} (${notice.count} ${notice.count === 1 ? "time" : "times"} since ${notice.firstAt}, last ${notice.lastAt}). ${notice.consequence}`,
      reason: `${notice.channel}-failing`,
      hint: notice.hint,
    });
  try {
    await deps.store.read();
  } catch (error) {
    checks.push({
      name: "runtime-state",
      ok: false,
      message:
        error instanceof RigError
          ? error.message
          : "Runtime state is unreadable.",
      reason: "state-corrupt",
      hint:
        error instanceof RigError
          ? error.hint
          : "rigd could not read runtime/state.json under the Rig root: check that the file exists and rigd's user can read it, then run rig doctor again.",
    });
  }
  return checks;
}
/** A failing `route-owners` check when the route file holds blocks whose Target no state record names: such a block holds its
 * hostnames from every new owner (ROUTE_CONFLICT) until it is withdrawn. Undefined when there is none, or when the route
 * file or the state cannot be read (other checks report that). The route file is read before the state, and every Target
 * is recorded before its route is published, so a deploy in progress is never reported. Doctor takes no lock, so a
 * `rig forget` running between the two reads (its routes read before it withdrew them, its records after it dropped
 * them) can be reported once; accepted, since the next doctor no longer sees it and doctor changes nothing. */
async function orphanedRoutesCheck(
  deps: Pick<RuntimeDependencies, "inspectProxy" | "store" | "routeFileInRoot">,
): Promise<DoctorCheck | undefined> {
  let publication, state;
  try {
    publication = await deps.inspectProxy();
    state = await deps.store.read();
  } catch {
    return undefined;
  }
  const owned = new Set(
    state.targets.map((target) => routeOwnerToken(target.id)),
  );
  const orphaned = publication.blocks.filter(
    (block) => !owned.has(block.token),
  );
  if (!orphaned.length) return undefined;
  const hostnames = orphaned.flatMap((block) =>
    block.hostnames.length
      ? block.hostnames
      : [`(route ${block.token.slice(0, 12)})`],
  );
  const inRoot = (await deps.routeFileInRoot?.().catch(() => false)) ?? true;
  const summary = `${publication.proxyFile} holds ${orphaned.length === 1 ? "a route" : `${orphaned.length} routes`} whose Target no longer exists, for ${hostnames.join(", ")}. No Target can publish ${hostnames.length === 1 ? "that hostname" : "those hostnames"} until ${orphaned.length === 1 ? "it is" : "they are"} withdrawn.`;
  return {
    name: "route-owners",
    ok: false,
    message: inRoot
      ? summary
      : `${summary} The file lies outside the Rig root, so another Rig root may own ${orphaned.length === 1 ? "it" : "them"}: Rig withdraws ${orphaned.length === 1 ? "it" : "them"} only when asked.`,
    reason: "route-orphaned",
    hint: inRoot
      ? "Run rig proxy reload to withdraw them now. rigd also withdraws them when it starts and before a deploy, up or restart publishes a route."
      : `If no other Rig root writes routes to ${publication.proxyFile}, run rig proxy reload to withdraw them.`,
  };
}
/** A `tool-owners` check when `<RIG_ROOT>/bin` holds Tools whose owner Target no state record names (#343): a forgotten
 * Project's, or a lost Target's. One whose bytes are still the ones Rig published is released, and the next Target that
 * publishes there takes it over (`bin/rig` and `bin/rigd` only a Target of the Project that published them): reported,
 * passing. One that changed since is never replaced or removed, so a Target that publishes there is refused
 * (ARTIFACT_CHANGED) until it is moved: the check fails. Undefined when there is none, or when the Tools or the state cannot be read
 * (other checks report that). The ownership records are read before the state, and every Target is recorded before it
 * publishes a Tool, so a deploy in progress is never reported; a `rig forget` running meanwhile can be, once. */
async function orphanedToolsCheck(
  deps: Pick<RuntimeDependencies, "orphanedTools" | "store" | "root">,
): Promise<DoctorCheck | undefined> {
  if (!deps.orphanedTools) return undefined;
  let orphans;
  try {
    orphans = await deps.orphanedTools(
      async () =>
        new Set((await deps.store.read()).targets.map((target) => target.id)),
    );
  } catch {
    return undefined;
  }
  if (!orphans.length) return undefined;
  const named = (tool: OrphanedTool) =>
    `${tool.destination} (${
      tool.owner.project && tool.owner.target
        ? `Project '${tool.owner.project}' Target '${tool.owner.target}' `
        : ""
    }Tool '${tool.owner.componentName}')`;
  const released = orphans.filter((tool) => !tool.changed);
  const changed = orphans.filter((tool) => tool.changed);
  const message = [
    released.length
      ? `${released.length === 1 ? "A Tool belongs" : `${released.length} Tools belong`} to a Target that no longer exists: ${released.map(named).join(", ")}. ${released.length === 1 ? "It stays" : "They stay"} installed as Rig published ${released.length === 1 ? "it" : "them"}, and the next Target that publishes a Tool of the same name takes ${released.length === 1 ? "it" : "each"} over.`
      : "",
    changed.length
      ? `${changed.length === 1 ? "A Tool" : `${changed.length} Tools`} whose Target no longer exists changed since Rig published ${changed.length === 1 ? "it" : "them"}: ${changed.map(named).join(", ")}. Rig never replaces or removes ${changed.length === 1 ? "it" : "them"}, so a Target that publishes there is refused (ARTIFACT_CHANGED).`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  // rigd's system job runs <RIG_ROOT>/bin/rigd, and rig is the CLI that drives it: deleting either strands the Host.
  const rigOwn = orphans
    .map((tool) => tool.destination)
    .filter((path) =>
      [join(deps.root, "bin", "rigd"), join(deps.root, "bin", "rig")].includes(
        path,
      ),
    );
  return {
    name: "tool-owners",
    // A released Tool is reported, not failed: it keeps working and the next Target that publishes there takes it over. A
    // changed one fails the check, since it refuses every publication there until it is moved.
    ok: changed.length === 0,
    message,
    reason: changed.length ? "tool-changed" : "tool-orphaned",
    hint: [
      released.length
        ? "Nothing needs doing to keep using them: a deploy or rig up that publishes a Tool of the same name replaces one. Delete one you no longer want."
        : "",
      changed.length
        ? changed.some((tool) => rigOwn.includes(tool.destination))
          ? "Move or delete a changed one to keep or discard that change, except rig and rigd: for those, put back the bytes whose SHA-256 the ownership record in installed/owners names, by copying them to a temporary name beside it and renaming that over it. A Target can then publish there."
          : "Move or delete a changed one to keep or discard that change; a Target can then publish there."
        : "",
      rigOwn.length
        ? `Never delete ${rigOwn.join(" or ")}: ${rigOwn.length === 1 ? "it is" : "they are"} Rig itself, and rigd's system job runs ${join(deps.root, "bin", "rigd")}. Only the repository that published ${rigOwn.length === 1 ? "it" : "them"} takes ${rigOwn.length === 1 ? "it" : "them"} over: register it (any clone) again and deploy its stable Target. One published before Rig recorded its repository goes to no one; upgrade with the manual steps of the rig:rigd skill's upgrade reference.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}
/** A failing `project-names` check for registered Projects the name rule refuses now but registered before it: names that
 * differ only in case, which share one operator env directory and their Tools' paths on a Mac's disk, and names too long
 * for a selector. They keep working; a rename gives each its own name. Undefined when there is none or the state cannot be
 * read (another check reports that). */
async function projectNamesCheck(
  deps: Pick<RuntimeDependencies, "store" | "root">,
): Promise<DoctorCheck | undefined> {
  let projects: readonly ProjectRecord[];
  try {
    projects = (await deps.store.read()).projects;
  } catch {
    return undefined;
  }
  const groups = new Map<string, string[]>();
  for (const project of projects)
    groups.set(nameKey(project.name), [
      ...(groups.get(nameKey(project.name)) ?? []),
      project.name,
    ]);
  const shared = [...groups.values()].filter((names) => names.length > 1);
  const long = projects.filter(
    (project) => project.name.length > MAX_NAME_LENGTH,
  );
  if (!shared.length && !long.length) return undefined;
  const quoted = (names: readonly string[]) =>
    names.map((name) => `'${name}'`).join(" and ");
  const shorten = (project: ProjectRecord) => `${project.name.slice(0, 40)}...`;
  return {
    name: "project-names",
    ok: false,
    message: [
      ...shared.map(
        (names) =>
          `Projects ${quoted(names)} have names that differ only in case, which a Mac's disk does not tell apart: they share the operator env files under ${join(deps.root, "env", names[0]!)} and their Tools' paths.`,
      ),
      ...long.map(
        (project) =>
          `Project '${shorten(project)}' has a name of ${project.name.length} characters, but --project and the dashboard select names of at most ${MAX_NAME_LENGTH}.`,
      ),
    ].join(" "),
    reason: "project-name",
    hint: [
      ...shared.map(
        (names) =>
          `Rename all but one of ${quoted(names)}: run rig rename <new name> --project ${shellWord(names[names.length - 1]!)}. The renamed Project keeps a copy of the env files; remove from each copy what belongs to the other Project.`,
      ),
      ...long.map(
        (project) =>
          `In ${project.repoPath}, change name in rig.yaml to at most ${MAX_NAME_LENGTH} characters, then run rig rename <that name> there.`,
      ),
    ].join(" "),
  };
}
/** A failing `<preview>/name` check for a Preview recorded under a name the rule for new Previews refuses: a spelling of a
 * reserved name, one that differs only in case from another of the Project's Previews, or one too long for a selector.
 * It keeps working; deploying its Branch under another name and destroying it replaces it. Undefined for any other Target. */
function previewNameCheck(
  target: TargetRecord,
  targets: readonly TargetRecord[],
): DoctorCheck | undefined {
  if (target.kind !== "preview") return undefined;
  const reserved = reservedPreviewName(target.name);
  const variant = caseVariantOf(
    target.name,
    targets.filter((t) => t.kind === "preview").map((t) => t.name),
  );
  const problem = nameProblem(target.name);
  const why = reserved
    ? `its name is reserved: ${reservedBecause(reserved)}${reserved === target.name ? "" : ", and a Mac's disk does not tell case apart"}.`
    : variant !== undefined
      ? `its name differs only in case from Preview '${variant}', which a Mac's disk does not tell apart: they share their Tools' paths.`
      : problem
        ? `its name ${problem}.`
        : undefined;
  if (!why) return undefined;
  return {
    name: `${target.name}/name`,
    ok: false,
    message: `Preview '${target.name}' was deployed before Rig refused such names, and ${why}`,
    reason: "preview-name",
    hint: `It keeps working. To replace it, run rig deploy preview ${target.branch ? `${shellWord(target.branch)} ` : "<branch> "}--deployment <new name>, then ${rigCommand("down", { target }, "--destroy")}, which deletes its data.`,
  };
}
export async function doctor(
  project: ProjectRecord,
  targets: TargetRecord[],
  deps: RuntimeDependencies & { inProgress(operationId: string): boolean },
): Promise<DoctorReport> {
  const checks = await inspectRuntimeHost(deps);
  // One acquisition serves identity and every Working copy comparison, so a concurrent edit cannot split one report across revisions.
  const repository = await acquireDocument(
    project.repoPath,
    project,
    deps.documents,
  );
  checks.push(projectConfigCheck(project, repository));
  if (project.renaming)
    checks.push({
      name: "project-rename",
      ok: false,
      message:
        project.renaming.to === project.name
          ? `Writing name: ${project.name} back to rig.yaml (from '${project.renaming.config}') did not finish.`
          : `A rename of '${project.name}' to '${project.renaming.to}' did not finish: its rig.yaml or operator env files may have the new name already.`,
      reason: "rename-unfinished",
      hint: pendingRenameAdvice(project, project.renaming),
    });
  for (const target of targets) {
    const named = previewNameCheck(target, targets);
    if (named) checks.push(named);
    if (target.deploymentIncomplete && !target.recovery)
      checks.push({
        name: `${target.name}/deployment`,
        ok: false,
        message:
          "The last deploy did not complete; its executables and route were not committed.",
        reason: "deployment-incomplete",
        hint:
          target.kind === "working"
            ? `Run ${rigCommand("up", { target })} to finish it.`
            : `Run ${rigCommand("up", { target })} to finish it, or ${rigCommand("deploy", { target }, "--force")} to deploy it again.`,
      });
    if (target.destructionPending)
      checks.push({
        name: `${target.name}/destruction`,
        ok: false,
        message:
          "Preview destruction is incomplete; its stopped inventory is retained.",
        reason: "destruction-pending",
        hint: `Run ${rigCommand("down", { target }, "--destroy")} again to finish cleanup.`,
      });
    if (transitionInProgress(target, deps.inProgress))
      checks.push({
        name: `${target.name}/deploy`,
        ok: true,
        message: `A deploy is in progress (operation ${target.recovery!.operationId}).`,
        reason: "deployment-in-progress",
      });
    else if (target.recovery)
      checks.push({
        name: `${target.name}/recovery`,
        ok: false,
        message:
          "Deployment recovery is unresolved; Component ownership is uncertain.",
        reason: "deployment-recovery",
        hint: `Run ${rigCommand("down", { target })} to stop both recorded plans before retrying deployment.`,
      });
    // A deployed Target is planned from the committed config in its checkout; the working copy never reaches it.
    const source =
      target.kind === "working"
        ? repository
        : await acquireDocument(
            target.plan.workspacePath,
            project,
            deps.documents,
            "deployed",
          );
    checks.push(await configCheck(project, target, source, deps));
    if (source.outcome === "usable" && source.formerName)
      checks.push({
        name: `${target.name}/name`,
        ok: true,
        message: `The deployed revision's rig.yaml names '${source.formerName}', this Project's name before it was renamed '${project.name}'; it runs as '${project.name}'. Commit rig.yaml with the new name, and the next deploy records it.`,
      });
    const sites = plannedSites(target.plan);
    if (sites.length)
      checks.push({
        name: `${target.name}/hostnames`,
        ok: true,
        message: `Recorded hostnames: ${sites
          .map(
            (site) =>
              `${site.hostname} (${[...new Set(site.routes.map((route) => route.service))].join(", ")})`,
          )
          .join(", ")}.`,
      });
    if (target.kind === "stable" && repository.outcome === "usable")
      checks.push(
        productionBranchCheck(
          target,
          repository.document.config.production_branch ??
            (await deps.documents.host()).deploy.production_branch,
        ),
      );
    if (
      repository.outcome === "usable" &&
      !targetOn(repository.document.config, target.kind)
    )
      checks.push(targetOffCheck(target, repository.document.config));
  }
  // A Preview awaiting destruction has already retired its inventory; the destruction check names it, its components are not failures.
  const reports = await observeTargets(
    targets.filter((target) => !target.recovery && !target.destructionPending),
    deps.observations,
    deps.observationBudgetMs,
    deps.observationDeadline,
    deps.healthResults,
  );
  for (const report of reports)
    for (const component of report.components)
      checks.push(componentCheck(report, component, project.name));
  return {
    ok: checks.every((c) => c.ok),
    checks,
    project: project.name,
  };
}
/** A recorded Target whose role the checkout's rig.yaml leaves off, such as the working Target of a Project registered
 * when a rig.yaml without targets still turned working on. One recorded running is a problem: it keeps running, but up,
 * restart and deploy refuse it, so the check names the line that turns it on and the command that stops it. One recorded
 * stopped is only kept, and passes. */
function targetOffCheck(
  target: Pick<TargetRecord, "kind" | "name" | "branch" | "desired" | "plan">,
  config: Pick<ProjectConfig, "targets">,
): DoctorCheck {
  const name = `${target.name}/switch`;
  const off = `${roleLabel(target.kind)} off in rig.yaml`;
  if (target.desired !== "running")
    return {
      name,
      ok: true,
      message: `${off}; ${target.name} is stopped and stays recorded.`,
    };
  return {
    name,
    ok: false,
    message: `${off}, but ${target.name} is recorded running: it keeps running, and up, restart and deploy refuse it.`,
    reason: "target-off",
    hint: `${turnOnInstruction(config, target.kind)} to keep it, or run ${rigCommand("down", { target })} to stop it.`,
  };
}
/** The Stable Target serves whatever Branch it was deployed from; a Production setting changed since then is drift the operator acts on. */
function productionBranchCheck(
  target: Pick<TargetRecord, "kind" | "name" | "branch" | "plan">,
  production: string,
): DoctorCheck {
  const name = `${target.name}/branch`;
  if (target.branch === undefined)
    return {
      name,
      ok: true,
      message: `${target.name} was deployed from a Commit, not a Branch.`,
    };
  if (target.branch === production)
    return {
      name,
      ok: true,
      message: `${target.name} was deployed from Production '${production}'.`,
    };
  return {
    name,
    ok: false,
    message: `${target.name} was deployed from '${target.branch}', but Production is now '${production}'.`,
    reason: "production-branch-drift",
    hint: `Run ${rigCommand("deploy", { target })} to deploy '${production}', or set production_branch back to '${target.branch}'.`,
  };
}
/** One read of a config document, kept apart by why it cannot serve a comparison. */
type AcquiredDocument =
  | {
      outcome: "usable";
      document: ConfigDocument<ProjectConfig>;
      /** The name a deployed revision's config gives, one the Project had before a rename; the document carries the
       * Project's name, as the revision was planned. */
      formerName?: string;
    }
  | { outcome: "foreign"; document: ConfigDocument<ProjectConfig> }
  | { outcome: "invalid"; failure: ConfigError }
  | { outcome: "unreadable"; failure: Error };
/** Reads one config document once; a parser rejection and a failed read are different findings. A `deployed` revision's
 * config that names a former name of the Project is its own, from before a rename. */
async function acquireDocument(
  path: string,
  project: Pick<ProjectRecord, "name" | "formerNames">,
  documents: Pick<RuntimeDependencies["documents"], "read">,
  revision?: "deployed",
): Promise<AcquiredDocument> {
  try {
    const document = await documents.read(path);
    const named = document.config.name;
    if (revision === "deployed" && formerName(project, named))
      return {
        outcome: "usable",
        document: {
          ...document,
          config: { ...document.config, name: project.name },
        },
        formerName: named,
      };
    return named === project.name
      ? { outcome: "usable", document }
      : { outcome: "foreign", document };
  } catch (error) {
    if (error instanceof ConfigError)
      return { outcome: "invalid", failure: error };
    return {
      outcome: "unreadable",
      failure: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
const unreadableHint = (project: string) =>
  `Inspect the Project directory and file permissions, then run ${rigCommand("doctor", { project })} again.`;
function projectConfigCheck(
  project: Pick<ProjectRecord, "name" | "repoPath">,
  repository: AcquiredDocument,
): DoctorCheck {
  const name = "project-config";
  if (
    repository.outcome === "invalid" &&
    registeredDirectoryMissing(repository.failure)
  ) {
    const moved = movedProject(project);
    return {
      name,
      ok: false,
      message: moved.message,
      reason: "directory-missing",
      hint: moved.hint,
    };
  }
  switch (repository.outcome) {
    case "usable":
      return { name, ok: true, message: "Project config is valid." };
    case "foreign":
      return {
        name,
        ok: false,
        message: `The config names Project '${repository.document.config.name}', but it is registered as '${project.name}'.`,
        reason: "identity-drift",
        hint: identityDriftHint(project.name, repository.document.config.name),
      };
    case "invalid":
      return {
        name,
        ok: false,
        message: repository.failure.message,
        reason: "config-invalid",
        hint: repository.failure.hint,
      };
    case "unreadable":
      return {
        name,
        ok: false,
        message: `Project config could not be read. ${repository.failure.message}`,
        reason: "config-unreadable",
        hint: unreadableHint(project.name),
      };
  }
}
/** Compares the acquired config, resolved against the recorded ports, with the recorded plan read with the defaults of
 * fields added since it was recorded. A config that parses but adds components the record has no port for is drift, not an invalid config. */
async function configCheck(
  project: Pick<ProjectRecord, "name">,
  target: TargetRecord,
  source: AcquiredDocument,
  deps: Pick<RuntimeDependencies, "documents">,
): Promise<DoctorCheck> {
  const name = `${target.name}/config`;
  const label =
    target.kind === "working"
      ? "Current configuration"
      : "The deployed revision's configuration";
  const failing = (
    message: string,
    reason: string,
    hint: string,
  ): DoctorCheck => ({ name, ok: false, message, reason, hint });
  const drift = (message: string) =>
    failing(
      message,
      "config-drift",
      target.kind === "working"
        ? `Run ${rigCommand("restart", { target })} to apply the current configuration.`
        : `Run ${rigCommand("deploy", { target }, "--force")} to re-record the plan from the deployed revision; a same-Commit deploy without --force leaves the Target unchanged.`,
    );
  const invalid = (failure: ConfigError) =>
    failing(
      `Current Target policy could not be resolved. ${failure.message}`,
      "config-invalid",
      failure.hint,
    );
  switch (source.outcome) {
    case "unreadable":
      return failing(
        `${label} could not be read. ${source.failure.message}`,
        "config-unreadable",
        target.kind === "working"
          ? unreadableHint(project.name)
          : `Inspect the Target's checkout at ${target.plan.workspacePath}, or run ${rigCommand("deploy", { target }, "--force")} to prepare it again.`,
      );
    case "invalid":
      // A deployed revision is never edited in place: one committed before the Compose names stays as it was, and only
      // a deploy of a Commit that uses them replaces it. Its recorded plan still runs.
      return target.kind !== "working" && usesRenamedKeys(source.failure)
        ? failing(
            `${label} predates the Compose key names of ADR 0011 and 0012 (run is now command, env is now environment, ready is now healthcheck.test, ready_timeout is now healthcheck.start_period), so its policy was not compared. The Target still runs its recorded plan.`,
            "config-predates-rename",
            `Commit rig.yaml with the new names, then run ${rigCommand("deploy", { target })}; deploying a Commit that uses them clears this check. Deploying or rolling back to a Commit whose rig.yaml uses the old names is refused until it is updated.`,
          )
        : invalid(source.failure);
    case "foreign":
      return failing(
        `${label} names Project '${source.document.config.name}', not '${project.name}'; its policy was not compared.`,
        "identity-drift",
        identityDriftHint(project.name, source.document.config.name),
      );
    case "usable":
      break;
  }
  const { config } = source.document;
  const recorded = new Set(target.plan.components.map((c) => c.name));
  const added = Object.keys(config.services ?? {}).filter(
    (service) => !recorded.has(service),
  );
  try {
    const replanned = replannedPolicy(target, config, deps.documents.resolve);
    // A plan recorded before the planner wrote a field is compared as holding that field's default, and one recorded before
    // reference variables with today's plan as that rigd wrote it, so an upgrade alone is no drift.
    const current =
      target.plan.referenceValues === undefined
        ? withValuesWritten(replanned)
        : replanned;
    return isDeepStrictEqual(current, withPlanDefaults(target.plan))
      ? {
          name,
          ok: true,
          message:
            target.kind === "working"
              ? "Recorded Target policy matches current configuration."
              : "Recorded Target policy matches the deployed revision's configuration.",
        }
      : drift(`${label} differs from the recorded Target policy.`);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return error.code === "missing_port" && added.length
      ? drift(
          `${label} adds Services the recorded Target policy does not have (${added.join(", ")}).`,
        )
      : invalid(error);
  }
}
const HEALTHY_STATES = new Set([
  "running",
  "healthy",
  "ready",
  "installed",
  "stopped",
]);
/** A failing component's check keeps the observation's own reason and exit code; the hint follows what was observed. */
export function componentCheck(
  target: Pick<TargetRecord, "kind" | "name" | "branch">,
  component: ComponentReport,
  project: string,
): DoctorCheck {
  const name = `${target.name}/${component.name}`;
  if (HEALTHY_STATES.has(component.state))
    return { name, ok: true, message: `Component is ${component.state}.` };
  const reason =
    component.reason ??
    (component.exitCode === undefined
      ? undefined
      : `The process exited with code ${component.exitCode}.`);
  return {
    name,
    ok: false,
    message: `Component is ${component.state}.${reason ? ` ${reason}` : ""}`,
    reason: component.state,
    hint: componentHint({ project, target }, component),
  };
}
function componentHint(
  selection: {
    project: string;
    target: Pick<TargetRecord, "kind" | "name" | "branch">;
  },
  component: ComponentReport,
): string {
  const logs = rigCommand("logs", { ...selection, service: component.name });
  if (component.reason === OBSERVATION_EXPIRED)
    return `Run ${rigCommand("doctor", { project: selection.project })} again; the observation did not finish within the status budget.`;
  if (component.state === "unknown")
    return `Inspect daemon state (${rigCommand("activity", { project: selection.project })}, rigd status) before acting on this component.`;
  if (component.state === "failed" || component.exitCode !== undefined)
    return `Inspect the Target logs (${logs}) for why it exited.`;
  if (component.state === "unhealthy")
    return `Its health check failed; inspect the Target logs (${logs}) and the Service's healthcheck in rig.yaml.`;
  if (component.state === "missing")
    return `The installed artifact or storage is absent; run ${rigCommand("up", selection)} or redeploy this Target.`;
  return `Inspect the Target logs (${logs}) and provider configuration.`;
}

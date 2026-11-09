import { stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  BuildUnit,
  EnvFileRef,
  InstalledComponent,
  ManagedComponent,
  PlanComponent,
  PlanJob,
  TargetPlan,
} from "../config/types";
import { componentDirectory } from "../config/working-dir";
import type { TargetRecord } from "../domain/runtime";
import type { CommandRunner } from "../providers/contracts";
import {
  gitIgnoreCheck,
  loadEnvironmentFiles,
  readEnvironmentFile,
} from "./env-file";
import {
  assertGuardedInputs,
  assertRepresentableEnvironment,
  composeEnvironment,
  type LoadedEnvFile,
} from "../domain/process-environment";
import type { PublicInput } from "../config/references";
import { RigError, diagnosticErrorCode } from "../domain/errors";
import { assertContainedDirectory } from "../providers/contained-directory";
import { privateDirectory } from "../providers/private-files";
import type { TargetOutput } from "./target-output";
import type { UnusableEnvFile } from "../runtime/status";

/** The scope one invocation's environment is composed for: a Service, Tool or job, or the Project without one. */
export type InvocationScope = ManagedComponent | InstalledComponent | PlanJob;
/** Composes each invocation's environment afresh, its env files read now. */
export interface InvocationEnvironment {
  /** One invocation's environment, composed fresh each time: the controlled baseline with a Target-owned TMPDIR, the scope's
   * public env, its env files, then the plan's reference values. Overrides and permission warnings go to the Target log by
   * name, once per Target; file values go nowhere but the returned environment and `secrets`, the list of them to redact.
   * `forRunningProcess` is for a check of a process already running: see `loadEnvironmentFiles`; every other invocation
   * gets each value exactly or is refused. */
  compose(
    target: TargetRecord,
    component?: InvocationScope,
    /** Inputs of a Project-scope command, which no Component carries. */
    projectInputs?: NonNullable<BuildUnit["commandInputs"]>,
    forRunningProcess?: boolean,
  ): Promise<{ env: Record<string, string>; secrets: string[] }>;
  /** The environment `compose` returns, without its secrets. */
  environment(
    target: TargetRecord,
    component?: InvocationScope,
    projectInputs?: NonNullable<BuildUnit["commandInputs"]>,
  ): Promise<Record<string, string>>;
  /** Fails ENV_VALUE when a Service of `target` could not start for a value Rig refuses. */
  checkEnvironmentValues(target: TargetRecord): Promise<void>;
  /** The env files of `target`'s plan that `compose` would refuse now; see `ObservationEffects.unusableEnvFiles`. */
  unusableFiles(target: TargetRecord): Promise<UnusableEnvFile[]>;
}
/** Invocation environments over the baseline `environment`, with each Target's TMPDIR under `root`. `run` asks git whether
 * an env file inside the checkout is ignored; notes go to `output`. */
export function createInvocationEnvironment(options: {
  root: string;
  environment: Readonly<Record<string, string>>;
  run: CommandRunner;
  output: Pick<TargetOutput, "recordLines">;
}): InvocationEnvironment {
  const ignored = gitIgnoreCheck(options.run, options.environment);
  const noted = new Set<string>();
  const compose: InvocationEnvironment["compose"] = async (
    target,
    component,
    projectInputs = [],
    forRunningProcess = false,
  ) => {
    const scope = component ?? target.plan;
    const loaded = await loadEnvironmentFiles(
      scope.envFiles ?? [],
      target.plan.workspacePath,
      ignored,
      forRunningProcess,
    );
    const tmp = join(options.root, "tmp", target.id);
    const composed = composeEnvironment({
      baseline: { ...options.environment, TMPDIR: tmp },
      publicEnv: scope.env ?? {},
      files: loaded.files,
      guarded: component?.commandInputs ?? projectInputs,
      ...(component ? { component: component.name } : {}),
    });
    await privateDirectory(options.root, tmp);
    const notes = [
      ...loaded.warnings,
      ...composed.overrides.map(
        (override) =>
          `Environment name ${override.key} comes from ${override.sources.at(-1)}, overriding ${override.sources.slice(0, -1).join(", ")}.`,
      ),
    ];
    // Readiness polls compose too; a note is evidence once per Target, not once per poll.
    const fresh = notes.filter((note) => !noted.has(`${target.id}:${note}`));
    for (const note of fresh) noted.add(`${target.id}:${note}`);
    if (fresh.length)
      await options.output.recordLines(
        target,
        component?.name ?? "setup",
        "stderr",
        fresh,
      );
    // The values its commands read through _RIG_ variables come last.
    const env = {
      ...composed.env,
      ...referenceValuesOf(target.plan, component),
    };
    if (!forRunningProcess)
      assertRepresentableEnvironment(env, component?.name);
    return { env, secrets: composed.secrets };
  };
  return {
    compose,
    environment: async (target, component, projectInputs) =>
      (await compose(target, component, projectInputs)).env,
    async checkEnvironmentValues(target) {
      const managed = target.plan.components.filter(
        (component) => component.kind === "managed",
      );
      // A file several Services share is read once here; each start reads its own afresh.
      const paths = new Set(
        managed.flatMap((component) =>
          (component.envFiles ?? []).map(({ path }) => path),
        ),
      );
      for (const path of paths)
        await readEnvironmentFile(path).catch((error: unknown) => {
          if (diagnosticErrorCode(error) === "ENV_VALUE") throw error;
        });
      for (const component of managed)
        assertRepresentableEnvironment(
          {
            ...component.env,
            ...referenceValuesOf(target.plan, component),
          },
          component.name,
        );
    },
    async unusableFiles(target) {
      const { plan } = target;
      // A file the Project lists is in every scope's list too; it is named once, as the whole Project's.
      const project = new Set((plan.envFiles ?? []).map(({ path }) => path));
      /** Each invocation scope as `compose` composes it: its env files in order and the public inputs its commands were built
       * from, the shared build's for the Project. */
      const scopes: {
        reader: string;
        refs: readonly EnvFileRef[];
        guarded: readonly PublicInput[];
        component?: string;
      }[] = [
        {
          reader: "the whole Project",
          refs: plan.envFiles ?? [],
          guarded:
            plan.builds?.find((unit) => unit.component === undefined)
              ?.commandInputs ?? [],
        },
        ...[...plan.components, ...(plan.jobs ?? [])].flatMap((scope) =>
          "kind" in scope && scope.kind === "persistent"
            ? []
            : [
                {
                  reader: `${!("kind" in scope) ? "job" : scope.kind === "managed" ? "Service" : "Tool"} ${scope.name}`,
                  refs: scope.envFiles ?? [],
                  guarded: scope.commandInputs ?? [],
                  component: scope.name,
                },
              ],
        ),
      ];
      const files = new Map<string, { ref: EnvFileRef; readers: string[] }>();
      for (const { reader, refs } of scopes)
        for (const ref of refs) {
          const file = files.get(ref.path) ?? { ref, readers: [] };
          // Required wherever one scope lists it.
          if (ref.required) file.ref = ref;
          if (!project.has(ref.path) || reader === "the whole Project")
            file.readers.push(reader);
          files.set(ref.path, file);
        }
      const unusable: UnusableEnvFile[] = [];
      /** Each file's contents as a start loads it, or absent when it is skipped or refused. */
      const loaded = new Map<string, LoadedEnvFile | undefined>();
      for (const [path, { ref, readers }] of files)
        try {
          // As the next start reads it, which refuses a value no process could get exactly (ENV_VALUE), whether or not a
          // process started before Rig refused such values still runs.
          loaded.set(
            path,
            (await loadEnvironmentFiles([ref], plan.workspacePath, ignored))
              .files[0],
          );
        } catch (refusal) {
          if (!(refusal instanceof RigError)) throw refusal;
          unusable.push({ path, readers, refusal });
        }
      // Then each scope whose files all load is composed as a start composes it, its files in order, by the same rule.
      for (const scope of scopes) {
        if (scope.refs.some(({ path }) => !loaded.has(path))) continue;
        try {
          assertGuardedInputs({
            files: scope.refs.flatMap(({ path }) => loaded.get(path) ?? []),
            guarded: scope.guarded,
            ...(scope.component ? { component: scope.component } : {}),
          });
        } catch (refusal) {
          if (!(refusal instanceof RigError)) throw refusal;
          const sources = refusal.details.sources;
          unusable.push({
            path: Array.isArray(sources) ? String(sources.at(-1)) : "",
            readers: [scope.reader],
            refusal,
          });
        }
      }
      return unusable;
    },
  };
}
/** The reference values the commands of one scope read, by variable name: a Service's command, health check and build, a
 * job's command and restore, a Tool's build, or without a Component the shared build. Only these, so one Service's
 * environment changes only with its own values. */
export function referenceValuesOf(
  plan: TargetPlan,
  component?: InvocationScope,
): Record<string, string> {
  const values = plan.referenceValues ?? {};
  const units = (plan.builds ?? []).filter((unit) =>
    component === undefined
      ? unit.component === undefined
      : "kind" in component && unit.component === component.name,
  );
  const commands = [
    ...units.map((unit) => unit.command),
    ...(component && "command" in component ? [component.command] : []),
    ...(component && "health" in component && component.health !== undefined
      ? [component.health]
      : []),
    ...(component && "backup" in component && component.backup?.restore
      ? [component.backup.restore]
      : []),
  ];
  const names = commands.join("\n").match(/_RIG_[A-Za-z0-9_]+/g) ?? [];
  return Object.fromEntries(
    names.filter((name) => name in values).map((name) => [name, values[name]!]),
  );
}
/** The directory a Component's build or shell check runs in. A working_dir must be a directory inside the workspace,
 * symlinks followed; anything else fails before a command runs, naming the setting, rather than as a spawn failure. */
export async function runDirectory(
  target: TargetRecord,
  component: PlanComponent | undefined,
): Promise<string> {
  const directory = componentDirectory(target.plan, component);
  if (component?.kind !== "managed" || component.workingDir === undefined)
    return directory;
  await assertContainedDirectory(directory, target.plan.workspacePath);
  if (
    !(await stat(directory).then(
      (info) => info.isDirectory(),
      () => false,
    ))
  )
    throw new RigError(
      "WORKING_DIR_MISSING",
      `The working directory ${directory} of ${component.name} is not a directory.`,
      `Create ${component.workingDir} in the repository, or correct services.${component.name}.working_dir in rig.yaml; it must exist before its build runs.`,
      { directory, service: component.name },
    );
  return directory;
}

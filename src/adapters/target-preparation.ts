import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuildUnit, TargetPlan } from "../config/types";
import type { CommandRunner } from "../providers/contracts";
import { RigError } from "../domain/errors";
import { rigCommand } from "../domain/rig-command";
import { privateDirectory } from "../providers/private-files";
import type { TargetEffects } from "../runtime/lifecycle";
import {
  runDirectory,
  type InvocationEnvironment,
} from "./invocation-environment";
import type { TargetCommand } from "./target-commands";
import type { TargetOutput } from "./target-output";
import { prepareStorage } from "./prepared-storage";
import { exists } from "./path-exists";

/** Budget in seconds for dependency installation; rig.yaml has no setting for it. */
const DEFAULT_INSTALL_TIMEOUT_SECONDS = 600;
/** Written at a deployed workspace root once its dependencies are installed. */
const PREPARED_MARKER = ".rig-prepared";
/** The dependency installation a workspace asks for, by the first of these files it holds. */
const DEPENDENCY_INSTALLERS: readonly (readonly [string, readonly string[]])[] =
  [
    ["bun.lock", ["bun", "install", "--frozen-lockfile"]],
    ["bun.lockb", ["bun", "install", "--frozen-lockfile"]],
    ["package-lock.json", ["npm", "ci"]],
    ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
    ["yarn.lock", ["yarn", "install", "--frozen-lockfile"]],
    ["package.json", ["bun", "install"]],
  ];

/** A Target's workspace preparation and its builds. */
export type TargetPreparation = Pick<
  TargetEffects,
  "prepare" | "build" | "buildEnvironment" | "buildDirectory"
>;
/** Preparation under `root`: prepared storage, dependency installation once per immutable workspace, and builds, each run
 * by `command` in an environment from `environment`. `run` and the baseline `baseline` initialize prepared Postgres
 * storage. */
export function createTargetPreparation(options: {
  root: string;
  run: CommandRunner;
  baseline: Readonly<Record<string, string>>;
  command: TargetCommand;
  environment: Pick<InvocationEnvironment, "environment">;
  output: Pick<TargetOutput, "recordOutput">;
}): TargetPreparation {
  const { environment } = options.environment;
  return {
    async prepare(target, composed) {
      await privateDirectory(options.root, target.logRoot);
      await prepareStorage(target, {
        run: options.run,
        environment: options.baseline,
        output: options.output,
      });
      if (target.kind === "working") return;
      // The marker lives in the immutable workspace, so releasing the revision reclaims it too.
      const marker = join(target.plan.workspacePath, PREPARED_MARKER);
      if (await exists(marker)) return;
      // Dependency installation happens once per immutable workspace. Application builds remain Component policy.
      const command = await dependencyInstallCommand(target.plan.workspacePath);
      if (command) {
        const timeoutSeconds =
          target.plan.installTimeout ?? DEFAULT_INSTALL_TIMEOUT_SECONDS;
        const result = await options.command(
          command.join(" "),
          target,
          composed ? { ...composed } : await environment(target),
          timeoutSeconds,
        );
        if (result.timedOut)
          throw new RigError(
            "DEPENDENCIES_TIMEOUT",
            `Project dependency installation (${command.join(" ")}) did not finish within ${timeoutSeconds} s and was killed.`,
            `Its output so far is in ${rigCommand("logs", { target, service: "setup" })}. The budget is a fixed ten minutes that rig.yaml does not change: make the installation finish sooner (a warm package cache, or fewer dependencies), then deploy again.`,
            { command: command.join(" "), timeoutSeconds },
          );
        if (result.exitCode)
          throw new RigError(
            "DEPENDENCIES_FAILED",
            "Project dependency installation failed.",
            `Inspect its output (${rigCommand("logs", { target, service: "setup" })}), fix the cause, then deploy again.`,
          );
      }
      await writeFile(marker, "prepared\n", { mode: 0o600 });
    },
    buildEnvironment: async (unit, target) =>
      await environment(
        target,
        unitComponent(unit, target.plan),
        unit.commandInputs,
      ),
    buildDirectory: (unit, target) =>
      runDirectory(target, namedComponent(unit, target.plan)),
    async build(unit, target, composed) {
      const component = unitComponent(unit, target.plan);
      const name = unit.component ?? "setup";
      const result = await options.command(
        unit.command,
        target,
        composed
          ? { ...composed }
          : await environment(target, component, unit.commandInputs),
        unit.timeout,
        name,
        await runDirectory(target, namedComponent(unit, target.plan)),
      );
      const label =
        unit.component === undefined ? "shared" : `${unit.component}`;
      if (result.timedOut)
        throw new RigError(
          "BUILD_TIMEOUT",
          `The ${label} build did not finish within ${unit.timeout} s and was killed.`,
          `Inspect the ${name} Target logs for its output so far; set build_timeout if it needs longer. Nothing was started or published.`,
          { unit: unit.id, timeoutSeconds: unit.timeout },
        );
      if (result.exitCode)
        throw new RigError(
          "BUILD_FAILED",
          `The ${label} build failed.`,
          `Inspect the ${name} Target logs. Nothing was started or published.`,
          { unit: unit.id, exitCode: result.exitCode },
        );
    },
  };
}
/** The dependency installation command `workspace` asks for, or undefined when it has no package manifest. */
async function dependencyInstallCommand(
  workspace: string,
): Promise<readonly string[] | undefined> {
  for (const [file, command] of DEPENDENCY_INSTALLERS)
    if (await exists(join(workspace, file))) return command;
  return undefined;
}
/** The Component `unit` names in `plan`, of whatever kind; undefined for the shared unit or one the plan lacks. */
function namedComponent(unit: BuildUnit, plan: TargetPlan) {
  return plan.components.find((candidate) => candidate.name === unit.component);
}
/** The Component whose scope `unit` builds in: none for the shared unit (or a store's); BUILD_SCOPE for a unit that names
 * a Component the plan lacks. */
export function unitComponent(unit: BuildUnit, plan: TargetPlan) {
  const component = namedComponent(unit, plan);
  if (unit.component !== undefined && !component)
    throw new RigError(
      "BUILD_SCOPE",
      `Build unit ${unit.id} names no Component of this plan.`,
      "Deploy again so the plan and its build units are recorded together.",
      { unit: unit.id },
    );
  return component?.kind === "persistent" ? undefined : component;
}

import { lstat, mkdir, open, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PreparedComponent } from "../config/types";
import type { TargetRecord } from "../domain/runtime";
import type { CommandRunner } from "../providers/contracts";
import { RigError, failureCauses } from "../domain/errors";
import type { TargetOutput } from "./target-output";
import { exists } from "./path-exists";

/** Prepares the storage a plan of an older Rig version recorded as prepared Components (`preparedComponents`): a SQLite
 * file, a Convex state directory linked into the workspace, or a Postgres data directory initialized with initdb through
 * `run`, its output recorded through `output`. Rig plans none now; plans of the state versions it still reads may carry
 * them. */
export async function prepareStorage(
  target: TargetRecord,
  options: {
    run: CommandRunner;
    environment: Readonly<Record<string, string>>;
    output: Pick<TargetOutput, "recordOutput">;
  },
): Promise<void> {
  for (const component of target.plan.preparedComponents) {
    await mkdir(storageDirectory(component), { recursive: true, mode: 0o700 });
    if (component.uses === "convex")
      await linkConvexState(target.plan.workspacePath, component.stateDir);
    if (component.uses === "sqlite") {
      const file = await open(component.path, "a", 0o600);
      await file.close();
    }
    if (
      component.uses === "postgres" &&
      !(await exists(join(component.dataDir, "PG_VERSION")))
    )
      await initializePostgres(target, component, options);
  }
}
/** The directory a prepared Component's storage lives in. */
export function storageDirectory(component: PreparedComponent): string {
  return component.uses === "sqlite"
    ? dirname(component.path)
    : component.uses === "convex"
      ? component.stateDir
      : component.dataDir;
}
async function initializePostgres(
  target: TargetRecord,
  component: Extract<PreparedComponent, { uses: "postgres" }>,
  options: Parameters<typeof prepareStorage>[1],
): Promise<void> {
  let result;
  try {
    result = await options.run({
      command: [
        "initdb",
        "-E",
        "UTF8",
        "-A",
        "trust",
        "--no-locale",
        "-D",
        component.dataDir,
      ],
      env: options.environment,
    });
  } catch (error) {
    if (!(error instanceof RigError) || error.code !== "COMMAND_START")
      throw error;
    throw new RigError(
      "POSTGRES_INIT",
      `initdb is not installed or not on rigd's PATH, so the Postgres storage for ${component.name} could not be initialized.`,
      "Install PostgreSQL (for example brew install postgresql@17) so initdb, postgres and pg_isready are on the PATH rigd was installed from, then retry.",
      { component: component.name },
      failureCauses(error),
    );
  }
  await options.output.recordOutput(result, target, component.name);
  if (result.exitCode)
    throw new RigError(
      "POSTGRES_INIT",
      `initdb exited with code ${result.exitCode}, so the Postgres storage for ${component.name} could not be initialized.`,
      "Inspect the Target setup logs for initdb's output.",
      { component: component.name, exitCode: result.exitCode },
    );
}
/** Convex only knows `<cwd>/.convex/local/default`; a deployed checkout is pointed at the persistent state directory instead of growing its own. */
async function linkConvexState(
  workspacePath: string,
  stateDir: string,
): Promise<void> {
  const expected = join(workspacePath, ".convex", "local", "default");
  if (resolve(stateDir) === expected) return;
  const current = await lstat(expected).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (current?.isSymbolicLink()) {
    if ((await readlink(expected)) === stateDir) return;
    await rm(expected);
  } else if (current)
    throw new RigError(
      "CONVEX_STATE_CONFLICT",
      "The deployment checkout already contains Convex local state.",
      "Remove .convex/local/default from the repository so Rig can keep Convex state in Target storage.",
      { path: expected, stateDir },
    );
  await mkdir(dirname(expected), { recursive: true, mode: 0o700 });
  await symlink(stateDir, expected);
}

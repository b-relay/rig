import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { TargetRecord } from "../domain/runtime";
import type { RuntimeFiles } from "../runtime/contracts";
import { RigError } from "../domain/errors";

/** Filesystem effect owner. Inventory proves identity; canonical paths prove scope.
 * Directory symlinks and mount boundaries cannot expand the deletion boundary.
 */
export const destroyPreview: RuntimeFiles["destroyPreview"] = async (input) => {
  const base = await deletionRoot(input);
  try {
    await rm(base, { recursive: true, force: true });
  } catch (cause) {
    throw new RigError(
      "DESTROY_CLEANUP",
      "Preview storage cleanup is incomplete.",
      "The stopped Preview remains recorded. Retry down preview --destroy to finish cleanup.",
      { path: base, cause },
    );
  }
};
export const inspectPreviewDeletion: RuntimeFiles["inspectPreviewDeletion"] =
  async (input) => {
    await deletionRoot(input);
  };
async function deletionRoot(
  input: import("../runtime/contracts").PreviewDeletion,
): Promise<string> {
  try {
    return await inspectDeletionRoot(input);
  } catch (cause) {
    if (cause instanceof RigError) throw cause;
    throw new RigError(
      "DESTROY_OWNERSHIP",
      "Preview storage could not be inspected safely.",
      "Inspect filesystem permissions and ownership before retrying explicit destroy.",
      { cause },
    );
  }
}
async function inspectDeletionRoot({
  root,
  target,
  state,
}: import("../runtime/contracts").PreviewDeletion): Promise<string> {
  const reject = () =>
    new RigError(
      "DESTROY_OWNERSHIP",
      "Preview storage ownership cannot be verified.",
      "Inspect the retained Preview paths and retry explicit destroy after resolving ownership.",
    );
  const segment = (value: string) =>
    value !== "." && value !== ".." && /^[A-Za-z0-9_-]+$/.test(value);
  if (
    target.kind !== "preview" ||
    target.plan.target !== "preview" ||
    !segment(target.id) ||
    !segment(target.projectId) ||
    target.recovery
  )
    throw reject();
  const base = resolve(root, "targets", target.projectId, target.id);
  if (
    resolve(target.plan.dataRoot) !== join(base, "data") ||
    resolve(target.logRoot) !== join(base, "logs") ||
    !target.sourceRoot ||
    resolve(target.sourceRoot) !== join(base, "revisions") ||
    !within(join(base, "revisions"), resolve(target.plan.workspacePath))
  )
    throw reject();
  // The configured root may itself have a platform alias (/tmp on macOS).
  // Every directory beneath that trusted root must be a real directory.
  const physicalRoot = await realpath(root);
  const device = (await lstat(physicalRoot)).dev;
  let parent = physicalRoot;
  for (const part of ["targets", target.projectId, target.id]) {
    parent = join(parent, part);
    const entry = await maybeStat(parent);
    if (
      entry &&
      (!entry.isDirectory() || entry.isSymbolicLink() || entry.dev !== device)
    )
      throw reject();
  }
  const physicalBase = join(
    physicalRoot,
    "targets",
    target.projectId,
    target.id,
  );
  const protectedPaths = [
    ...state.projects.flatMap((project) => [
      project.repoPath,
      project.configPath,
    ]),
    ...state.targets
      .filter((record) => record.id !== target.id)
      .flatMap(recordPaths),
  ];
  if (state.targets.filter((record) => record.id === target.id).length !== 1)
    throw reject();
  for (const path of protectedPaths) {
    const physical = await physicalPath(resolve(path));
    if (overlaps(physicalBase, physical)) throw reject();
  }
  const entry = await maybeStat(physicalBase);
  if (entry) await verifyTree(physicalBase, entry.dev, reject);
  return physicalBase;
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !path.startsWith(sep)
  );
}
function overlaps(first: string, second: string): boolean {
  return first === second || within(first, second) || within(second, first);
}
function recordPaths(target: TargetRecord): string[] {
  const plans = [
    target.plan,
    ...(target.recovery ? [target.recovery.plan] : []),
  ];
  return [
    target.logRoot,
    ...(target.sourceRoot ? [target.sourceRoot] : []),
    ...plans.flatMap((plan) => [
      plan.workspacePath,
      plan.dataRoot,
      ...plan.components.flatMap((component) =>
        component.kind === "persistent" ? [component.path] : [],
      ),
      ...plan.preparedComponents.map((component) =>
        component.uses === "sqlite"
          ? component.path
          : component.uses === "convex"
            ? component.stateDir
            : component.dataDir,
      ),
    ]),
  ];
}
async function maybeStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
/** Resolve aliases even when the final file has not been created yet. */
async function physicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" ||
      dirname(path) === path
    )
      throw error;
    return join(
      await physicalPath(dirname(path)),
      path.slice(dirname(path).length + 1),
    );
  }
}
async function verifyTree(
  path: string,
  device: number,
  reject: () => RigError,
): Promise<void> {
  for (const name of await readdir(path)) {
    const child = join(path, name),
      entry = await lstat(child);
    if (entry.dev !== device) throw reject();
    // rm unlinks symlinks themselves; it never traverses their destinations.
    if (entry.isDirectory() && !entry.isSymbolicLink())
      await verifyTree(child, device, reject);
  }
}

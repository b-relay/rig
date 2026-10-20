import {
  chmod,
  lstat,
  mkdir,
  readdir,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { RigError } from "../domain/errors";
import { within } from "../domain/paths";
import type { BackupScope, BackupStorage } from "../runtime/contracts";

/** A backup directory: its owner's alone, under the private backups root. */
const BACKUP_DIRECTORY_MODE = 0o700;
/** Read, write and search for the owner: what deleting a directory's entries needs. */
const OWNER_ACCESS = 0o700;

/** Backups on the Mac's disk, under `<root>/backups/<project>/<target>/<job>/<id>` (ADR 0017). Every path it is handed must
 * lie inside `<root>/backups`, and every directory between that root and the path must be a real directory, not a symlink:
 * otherwise a path is refused for creating, read as absent, and skipped for deleting, so nothing outside the root is ever
 * created, counted or deleted through it. The root itself may be a symlink. Nothing inside a backup is ever opened: sizes
 * come from lstat, and deleting never follows a symlink. Modes change only when a backup cannot be deleted because its owner
 * may not write in a directory of it: those of its own real directories are given back to the owner, and the deletion tried
 * again. A backup with another volume mounted inside it is not deleted at all, so nothing on that volume is touched. */
export function createBackupStorage(root: string): BackupStorage {
  const base = resolve(root, "backups");
  const inside = (path: string): string => {
    const absolute = resolve(path);
    if (!within(base, absolute))
      throw new RigError(
        "BACKUP_PATH",
        `${path} is not inside Rig's backup directory ${base}, so Rig will not touch it.`,
        "The state names a backup outside RIG_ROOT/backups; repair the record by hand (rig doctor shows the state file).",
        { path, base },
      );
    return absolute;
  };
  const unsafe = (at: string) =>
    new RigError(
      "BACKUP_PATH",
      `${at} is a symlink or not a directory, so Rig will not create or read a backup through it.`,
      `Every directory between ${base} and a backup must be a real directory: replace the symlink with one, then retry.`,
      { path: at, base },
    );
  return {
    location: (scope: BackupScope, id: string) =>
      join(base, scope.project, scope.target, scope.job, id),
    async create(path) {
      const absolute = inside(path);
      // Checked before and after the parents are made: mkdir -p would follow a symlinked parent.
      const parents = async () => {
        const found = await ancestors(base, absolute);
        if (found.state === "unsafe") throw unsafe(found.at);
      };
      await parents();
      // Twice at most: a removal running beside this one may prune the empty parent between the two mkdirs.
      for (let attempt = 1; ; attempt++)
        try {
          await mkdir(dirname(absolute), {
            recursive: true,
            mode: BACKUP_DIRECTORY_MODE,
          });
          await parents();
          // Not recursive: an existing directory fails, so a run never writes into one it did not get fresh. The mode
          // asked for is narrowed by the umask only, never widened: the private root keeps it the owner's either way.
          await mkdir(absolute, { mode: BACKUP_DIRECTORY_MODE });
          return;
        } catch (error) {
          if (error instanceof RigError) throw error;
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" && attempt === 1) continue;
          throw new RigError(
            "BACKUP_DIRECTORY",
            code === "EEXIST"
              ? `The backup directory ${absolute} already exists, so no run was started.`
              : `The backup directory ${absolute} could not be created${code ? ` (${code})` : ""}.`,
            "Check the disk and the permissions under RIG_ROOT/backups, then run the job again.",
            { path: absolute, ...(code ? { code } : {}) },
          );
        }
    },
    async exists(path) {
      const absolute = inside(path);
      if ((await ancestors(base, absolute)).state !== "safe") return false;
      try {
        // Not followed: a backup directory a run replaced with a symlink is no backup.
        return (await lstat(absolute)).isDirectory();
      } catch {
        return false;
      }
    },
    async measure(path) {
      const absolute = inside(path);
      if ((await ancestors(base, absolute)).state !== "safe") return undefined;
      try {
        if (!(await lstat(absolute)).isDirectory()) return undefined;
        return await sizeOf(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw failure("BACKUP_MEASURE", "measure", absolute, error);
      }
    },
    async remove(path) {
      const absolute = inside(path);
      const found = await ancestors(base, absolute);
      // A symlinked parent would point the deletion outside the root: skipped, never followed.
      if (found.state === "unsafe") return "skipped";
      if (found.state === "safe") {
        // fs.rm never follows a symlink, but it does enter a volume mounted inside the backup: each attempt is checked first.
        const volume = (await stat(base)).dev;
        try {
          await prepareRemoval(absolute, volume, false);
          // A symlink here, or anywhere below, is removed as the link itself.
          await rm(absolute, { recursive: true, force: true });
        } catch (error) {
          if (error instanceof RigError) throw error;
          // Most likely a directory the owner may not write in (sealed 0500 by an earlier Rig, or made so by the job),
          // which fails as EACCES or, from deeper down, ENOTEMPTY: opened, then deleted again.
          try {
            await prepareRemoval(absolute, volume, true);
            await rm(absolute, { recursive: true, force: true });
          } catch (again) {
            throw failure("BACKUP_REMOVE", "delete", absolute, again);
          }
        }
      }
      await pruneEmptyParents(dirname(absolute), base);
      return "removed";
    },
  };
}
/** Whether every directory from `base` (exclusive) down to `path` (exclusive) is a real directory: `safe`, `missing` when
 * one does not exist (so neither does `path`), or `unsafe` at the first that is a symlink or not a directory. */
async function ancestors(
  base: string,
  path: string,
): Promise<{ state: "safe" | "missing" } | { state: "unsafe"; at: string }> {
  const parts = relative(base, path).split(sep).slice(0, -1);
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { state: "missing" };
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      return { state: "unsafe", at: current };
  }
  return { state: "safe" };
}
/** The bytes under the directory `path`, every entry counted by its own lstat size: nothing is followed or opened. */
async function sizeOf(path: string): Promise<number> {
  let bytes = 0;
  for (const name of await readdir(path)) {
    const entry = join(path, name);
    const info = await lstat(entry);
    bytes += info.isDirectory() ? await sizeOf(entry) : info.size;
  }
  return bytes;
}
/** Before `path` is deleted: fails BACKUP_REMOVE, changing nothing more, at the first directory in it on another volume than
 * `volume` (the backup root's), so a volume mounted inside a backup is never entered. With `reopen`, also gives the owner
 * back read, write and search on each directory in it that the current user owns, so its entries can be deleted. Nothing is
 * followed: an entry is looked at with lstat, and only a real directory is entered or changed, never a symlink or a file (a
 * file's mode may be shared through a hard link with one outside the backup). A directory that cannot be listed is not
 * entered, as the deletion cannot enter it either. */
async function prepareRemoval(
  path: string,
  volume: number,
  reopen: boolean,
): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isDirectory()) return;
  if (info.dev !== volume)
    throw new RigError(
      "BACKUP_REMOVE",
      `${path} is another volume mounted inside a backup, so Rig did not delete the backup.`,
      `Unmount it (diskutil unmount ${path}); Rig deletes the backup on its next pass, within 30 seconds.`,
      { path, mounted: true },
    );
  if (
    reopen &&
    info.uid === process.getuid?.() &&
    (info.mode & OWNER_ACCESS) !== OWNER_ACCESS
  )
    await chmod(path, (info.mode & 0o777) | OWNER_ACCESS);
  let names: string[];
  try {
    names = await readdir(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return;
    throw error;
  }
  for (const name of names)
    await prepareRemoval(join(path, name), volume, reopen);
}
/** A filesystem failure on a backup as a tagged error naming what Rig was doing. */
function failure(
  code: string,
  doing: string,
  path: string,
  error: unknown,
): RigError {
  if (error instanceof RigError) return error;
  const cause = (error as NodeJS.ErrnoException).code;
  return new RigError(
    code,
    `Rig could not ${doing} the backup ${path}${cause ? ` (${cause})` : ""}.`,
    "Check the disk and the permissions under RIG_ROOT/backups (Rig opens a backup's own directories before it deletes them, but not one another user owns), then retry.",
    { path, ...(cause ? { code: cause } : {}) },
  );
}
/** Removes `directory` and its parents while they are empty, stopping at `base`, which stays. */
async function pruneEmptyParents(
  directory: string,
  base: string,
): Promise<void> {
  for (
    let current = directory;
    within(base, current);
    current = dirname(current)
  )
    try {
      // rmdir never follows a symlink: one is refused (ENOTDIR) and ends the walk.
      await rmdir(current);
    } catch {
      return;
    }
}

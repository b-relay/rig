import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { RigError } from "../domain/errors";
import { within } from "../domain/paths";
import type { BackupScope, BackupStorage } from "../runtime/contracts";

/** Write bits for owner, group and others. */
const WRITE_BITS = 0o222;
/** A sealed backup directory: its owner may list and enter it, nobody may write in it. */
const SEALED_DIRECTORY = 0o500;
/** A backup directory while its run writes it, and while Rig deletes it. */
const OPEN_DIRECTORY = 0o700;

/** Backups on the Mac's disk, under `<root>/backups/<project>/<target>/<job>/<id>` (ADR 0017). Every path it is handed must
 * lie inside `<root>/backups`; anything else is refused, never touched. Nothing a backup holds is followed out of it: a
 * symlink is never followed, and a file with another hard link (the same file elsewhere, such as a live database) is never
 * made read-only. */
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
  return {
    location: (scope: BackupScope, id: string) =>
      join(base, scope.project, scope.target, scope.job, id),
    async create(path) {
      const absolute = inside(path);
      // Twice at most: a removal running beside this one may prune the empty parent between the two mkdirs.
      for (let attempt = 1; ; attempt++)
        try {
          await mkdir(dirname(absolute), {
            recursive: true,
            mode: OPEN_DIRECTORY,
          });
          // Not recursive: an existing directory fails, so a run never writes into one it did not get fresh.
          await mkdir(absolute, { mode: OPEN_DIRECTORY });
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" && attempt === 1) continue;
          throw new RigError(
            "BACKUP_DIRECTORY",
            code === "EEXIST"
              ? `The backup directory ${absolute} already exists, so no run was started.`
              : `The backup directory ${absolute} could not be created.`,
            "Check the disk and the permissions under RIG_ROOT/backups, then run the job again.",
            { path: absolute, code },
          );
        }
      try {
        // mkdir's mode is narrowed by the umask; the directory is the run's alone either way.
        await changeMode(absolute, OPEN_DIRECTORY);
      } catch (error) {
        // Made here, so it is this call's to take back: a failed create leaves nothing behind.
        await rm(absolute, { recursive: true, force: true }).catch(() => {});
        throw failure("BACKUP_DIRECTORY", "set up", absolute, error);
      }
    },
    async exists(path) {
      const absolute = inside(path);
      try {
        // Not followed: a backup directory a run replaced with a symlink is no backup.
        return (await lstat(absolute)).isDirectory();
      } catch {
        return false;
      }
    },
    async seal(path) {
      const absolute = inside(path);
      try {
        await walk(absolute, {
          file: async (entry) => {
            await changeMode(entry, (mode) => mode & ~WRITE_BITS, {
              singleLink: true,
            });
          },
          // Children first: a directory is closed only after everything in it was.
          directoryAfter: (entry) => changeMode(entry, SEALED_DIRECTORY),
        });
      } catch (error) {
        throw failure("BACKUP_SEAL", "make read-only", absolute, error);
      }
    },
    async measure(path) {
      const absolute = inside(path);
      try {
        await lstat(absolute);
      } catch {
        return undefined;
      }
      let bytes = 0;
      try {
        await walk(absolute, {
          file: async (_entry, size) => {
            bytes += size;
          },
          symlink: async (_entry, size) => {
            bytes += size;
          },
        });
      } catch (error) {
        throw failure("BACKUP_MEASURE", "measure", absolute, error);
      }
      return bytes;
    },
    async remove(path) {
      const absolute = inside(path);
      try {
        // A sealed directory cannot have entries removed from it until its owner may write in it again.
        await walk(absolute, {
          directoryBefore: (entry) => changeMode(entry, OPEN_DIRECTORY),
        });
        await rm(absolute, { recursive: true, force: true });
      } catch (error) {
        throw failure("BACKUP_REMOVE", "delete", absolute, error);
      }
      await pruneEmptyParents(dirname(absolute), base);
    },
  };
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
    "Check the disk and the permissions under RIG_ROOT/backups (a backup is read-only: chmod -R u+w opens it), then retry.",
    { path, ...(cause ? { code: cause } : {}) },
  );
}
/** Changes the mode of `path` through a descriptor opened without following a symlink, so an entry swapped for a symlink
 * after it was visited is left alone, as is an entry that cannot be opened for reading. With `singleLink`, a regular file
 * with other hard links (the same file elsewhere) is left alone too. */
async function changeMode(
  path: string,
  mode: number | ((current: number) => number),
  options: { singleLink?: boolean } = {},
): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ELOOP: a symlink now. EACCES: unreadable, which nothing reads back either. ENOENT: gone meanwhile.
    if (code === "ELOOP" || code === "EACCES" || code === "ENOENT") return;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (options.singleLink && info.isFile() && info.nlink > 1) return;
    await handle.chmod(typeof mode === "number" ? mode : mode(info.mode));
  } finally {
    await handle.close();
  }
}
/** Visits `path` and everything under it without following symlinks: `directoryBefore` before a directory is read,
 * `directoryAfter` once its entries were visited, `symlink` for a symlink (with its own size), and `file` for every other
 * entry. A path that is gone is nothing to visit. */
async function walk(
  path: string,
  visit: {
    file?(path: string, size: number): Promise<void>;
    symlink?(path: string, size: number): Promise<void>;
    directoryBefore?(path: string): Promise<void>;
    directoryAfter?(path: string): Promise<void>;
  },
): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    await visit.symlink?.(path, info.size);
    return;
  }
  if (!info.isDirectory()) {
    await visit.file?.(path, info.size);
    return;
  }
  await visit.directoryBefore?.(path);
  for (const name of await readdir(path)) await walk(join(path, name), visit);
  await visit.directoryAfter?.(path);
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
      await rmdir(current);
    } catch {
      return;
    }
}

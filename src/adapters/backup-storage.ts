import {
  chmod,
  lstat,
  mkdir,
  readdir,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
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
 * lie inside `<root>/backups`; anything else is refused, never touched. Symlinks a backup holds are never followed. */
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
      await mkdir(dirname(absolute), { recursive: true, mode: OPEN_DIRECTORY });
      try {
        // Not recursive: an existing directory fails, so a run never writes into one it did not get fresh.
        await mkdir(absolute, { mode: OPEN_DIRECTORY });
      } catch (error) {
        throw new RigError(
          "BACKUP_DIRECTORY",
          (error as NodeJS.ErrnoException).code === "EEXIST"
            ? `The backup directory ${absolute} already exists, so no run was started.`
            : `The backup directory ${absolute} could not be created.`,
          "Check the disk and the permissions under RIG_ROOT/backups, then run the job again.",
          { path: absolute, code: (error as NodeJS.ErrnoException).code },
        );
      }
      // mkdir's mode is narrowed by the umask; the directory is the run's alone either way.
      await chmod(absolute, OPEN_DIRECTORY);
    },
    async exists(path) {
      try {
        return (await stat(inside(path))).isDirectory();
      } catch (error) {
        if (error instanceof RigError) throw error;
        return false;
      }
    },
    async seal(path) {
      await walk(inside(path), {
        file: async (entry, mode) => chmod(entry, mode & ~WRITE_BITS),
        // Children first: a directory is closed only after everything in it was.
        directoryAfter: async (entry) => chmod(entry, SEALED_DIRECTORY),
      });
    },
    async measure(path) {
      const absolute = inside(path);
      try {
        await lstat(absolute);
      } catch {
        return undefined;
      }
      let bytes = 0;
      await walk(absolute, {
        file: async (_entry, _mode, size) => {
          bytes += size;
        },
        symlink: async (_entry, size) => {
          bytes += size;
        },
      });
      return bytes;
    },
    async remove(path) {
      const absolute = inside(path);
      try {
        await lstat(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await pruneEmptyParents(dirname(absolute), base);
          return;
        }
        throw error;
      }
      // A sealed directory cannot have entries removed from it until its owner may write in it again.
      await walk(absolute, {
        directoryBefore: async (entry) => chmod(entry, OPEN_DIRECTORY),
      });
      await rm(absolute, { recursive: true, force: true });
      await pruneEmptyParents(dirname(absolute), base);
    },
  };
}
/** Visits `path` and everything under it without following symlinks: `directoryBefore` before a directory is read,
 * `directoryAfter` once its entries were visited, `symlink` for a symlink (with its own size; its mode cannot be changed
 * without following it), and `file` for every other entry. A path that is gone is nothing to visit. */
async function walk(
  path: string,
  visit: {
    file?(path: string, mode: number, size: number): Promise<void>;
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
    await visit.file?.(path, info.mode, info.size);
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

import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { userInfo } from "node:os";
import { RigError } from "../domain/errors";
import { within } from "../domain/paths";

/** Rig's files under its root. Every directory from the root down to a file Rig writes is a real directory the current user
 * owns and no one else can write, made 0700 whatever the umask; a file is never written through a symbolic link, so nothing
 * planted under the root can send a write outside it. The root itself may be reached through a link.
 * The checks are made by path, and a writer may check a directory once and keep using it (a log): they stop other users and
 * anything planted at rest, not a process running as the same user that swaps a checked directory meanwhile. That user can
 * edit these files directly anyway, as ADR 0014's threat model says of the route file. */

const PRIVATE_DIRECTORY = 0o700;
const writableByOthers = (mode: number) => (mode & 0o022) !== 0;

/** Makes `directory` (the root or a directory below it) and every missing directory on the way, each 0700, and checks every
 * existing one: a symbolic link, a file, another user's directory, or one others can write fails RIG_ROOT_UNSAFE naming it.
 * A directory below the root that others can only read or search is made the owner's alone; the root is, only when it is
 * `directory` itself. */
export async function privateDirectory(
  root: string,
  directory: string,
): Promise<void> {
  await walk(root, directory, "make");
}

/** Replaces `path` whole: the bytes go to a new private file beside it (created exclusively, never through a link), which is
 * then renamed over whatever `path` was, so a reader sees the old file or the new one and a link at `path` is replaced, not
 * followed. `mode` is set exactly, whatever the umask. `durable` flushes the file before the rename and its directory after it; a directory
 * that cannot be flushed fails FILE_NOT_DURABLE, with the new contents already in place (`published: true`). `confirm` runs
 * once the new file is written, just before the rename; what it throws abandons the replacement. Any other failure leaves
 * `path` as it was and removes the temporary file. */
export async function replacePrivateFile(
  root: string,
  path: string,
  content: string | Uint8Array,
  options: {
    readonly mode?: number;
    readonly durable?: boolean;
    readonly confirm?: () => Promise<void>;
  } = {},
): Promise<void> {
  const directory = dirname(path);
  await privateDirectory(root, directory);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await openNew(temporary, options.mode ?? 0o600);
    try {
      await file.writeFile(content);
      if (options.durable) await file.sync();
    } finally {
      await file.close();
    }
    await options.confirm?.();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  if (options.durable)
    await syncDirectory(directory).catch((error: NodeJS.ErrnoException) => {
      throw notDurable(path, error);
    });
}

/** For a store a library opens itself, following links as it goes (SQLite): makes `directory` 0700 when it is missing and
 * checks it as `privateDirectory` does, creates `path` exclusively (0600, never through a link) when it is missing, and checks
 * `path` and each of `sidecars` that exists is a regular file the user owns that no one else can write. Synchronous, for
 * stores opened synchronously. The directory above `directory` is checked as rigd starts. */
export function preparePrivateStoreSync(
  path: string,
  sidecars: readonly string[],
): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY });
  assertPrivateDirectory(directory, lstatSync(directory));
  try {
    closeSync(
      openSync(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  for (const file of [path, ...sidecars]) {
    const info = lstatSync(file, { throwIfNoEntry: false });
    if (info) assertPrivateFile(file, info);
  }
}

/** Opens `path` in a private directory for writing, refusing a link there: `append` adds to it (creating it when missing),
 * `create` makes a new file and fails EEXIST when anything is already there. The file is left 0600. */
export async function openPrivateFile(
  root: string,
  path: string,
  how: "append" | "create",
): Promise<FileHandle> {
  await privateDirectory(root, dirname(path));
  return await openInPrivateDirectory(path, how);
}

/** Appends `text` to `path` in a directory the caller has already made with `privateDirectory`, refusing a link at `path`:
 * a writer that appends often checks its directory once and then appends with this. */
export async function appendInPrivateDirectory(
  path: string,
  text: string,
): Promise<void> {
  const file = await openInPrivateDirectory(path, "append");
  try {
    await file.writeFile(text);
  } finally {
    await file.close();
  }
}

async function openInPrivateDirectory(
  path: string,
  how: "append" | "create",
): Promise<FileHandle> {
  if (how === "create") return await openNew(path, 0o600);
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o600,
  ).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "ELOOP" ? linkRefused(path) : error;
  });
  try {
    const info = await file.stat();
    if (!info.isFile()) throw notPrivate(path, "is not a regular file");
    if ((info.mode & 0o777) !== 0o600) await file.chmod(0o600);
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Appends `text` to `path`, opened as `openPrivateFile` opens it. */
export async function appendPrivateFile(
  root: string,
  path: string,
  text: string,
): Promise<void> {
  await privateDirectory(root, dirname(path));
  await appendInPrivateDirectory(path, text);
}

/** The text of `path`, read only when every directory from `root` to it passes `privateDirectory`'s checks (none is made or
 * changed) and it is a regular file, not a link, that the current user owns and no one else can write; otherwise it fails
 * RIG_ROOT_UNSAFE or RIG_FILE_UNTRUSTED. The file is checked once opened, so it cannot be swapped between check and read. A
 * missing file fails with ENOENT for the caller to report. */
export async function readPrivateFile(
  root: string,
  path: string,
): Promise<string> {
  await walk(root, dirname(path), "check");
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "ELOOP"
      ? notPrivate(path, "is a symbolic link")
      : error;
  });
  try {
    assertPrivateFile(path, await file.stat());
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

/** Flushes `directory`'s entries, so a rename into it survives a crash. */
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function openNew(path: string, mode: number): Promise<FileHandle> {
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode,
  );
  try {
    await file.chmod(mode);
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** `make` creates what is missing and tightens what only others can read; `check` changes nothing. */
async function walk(
  root: string,
  directory: string,
  how: "make" | "check",
): Promise<void> {
  const base = resolve(root);
  const target = resolve(directory);
  if (target !== base && !within(base, target))
    throw new RigError(
      "RIG_ROOT_PATH",
      `${target} is not inside the Rig root ${base}.`,
      "This is a fault in Rig: it writes only under its root. Report it with the command that failed.",
      { root: base, path: target },
    );
  // The root itself may be a link (to another volume, say): it is judged where it leads.
  if (how === "make")
    await mkdir(base, { recursive: true, mode: PRIVATE_DIRECTORY });
  // The root is only checked on the way to a directory below it: it is tightened when it is the directory asked for.
  await checkDirectory(base, await stat(base), target === base ? how : "check");
  let current = base;
  for (const part of relative(base, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (how === "make") await mkdirOnce(current);
    await checkDirectory(current, await lstat(current), how);
  }
}

async function mkdirOnce(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY });
  } catch (error) {
    // Already there: it is checked like any existing directory.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function checkDirectory(
  path: string,
  info: Stats,
  how: "make" | "check",
): Promise<void> {
  assertPrivateDirectory(path, info);
  // Only the bits others have are taken away: what the owner may do stays as the owner set it.
  if (how === "make" && (info.mode & 0o077) !== 0)
    await chmod(path, info.mode & 0o700);
}

/** Fails RIG_ROOT_UNSAFE unless `info` (from lstat, or stat for the root) is a real directory the user owns that no one
 * else can write. */
function assertPrivateDirectory(path: string, info: Stats): void {
  if (info.isSymbolicLink()) throw linkRefused(path);
  if (!info.isDirectory())
    throw unsafe(
      path,
      "is not a directory",
      `Move ${path} aside, then retry; Rig makes the directory again.`,
    );
  if (info.uid !== currentUid())
    throw unsafe(
      path,
      `is owned by uid ${info.uid}, not by you`,
      `Check what is in it, then make it yours: sudo chown -R ${userInfo().username} ${path}`,
    );
  if (writableByOthers(info.mode))
    throw unsafe(
      path,
      "can be written by other users",
      `Check that nothing in it was changed by someone else, then make it private: chmod 700 ${path}`,
    );
}

/** Fails RIG_FILE_UNTRUSTED unless `info` (from lstat or fstat) is a regular file the user owns that no one else can write. */
function assertPrivateFile(path: string, info: Stats): void {
  if (info.isSymbolicLink()) throw notPrivate(path, "is a symbolic link");
  if (!info.isFile()) throw notPrivate(path, "is not a regular file");
  if (info.uid !== currentUid())
    throw notPrivate(path, `is owned by uid ${info.uid}, not by you`);
  if (writableByOthers(info.mode))
    throw notPrivate(path, "can be written by other users");
}

const currentUid = () => process.getuid?.() ?? -1;

const unsafe = (path: string, problem: string, hint: string) =>
  new RigError(
    "RIG_ROOT_UNSAFE",
    `${path} ${problem}, so Rig will not keep its files there.`,
    hint,
    { path, problem },
  );

const linkRefused = (path: string) =>
  unsafe(
    path,
    "is a symbolic link",
    `Rig writes only to real files and directories under its root. Replace the link at ${path} with a real directory or file (or remove it), then retry.`,
  );

const notPrivate = (path: string, problem: string) =>
  new RigError(
    "RIG_FILE_UNTRUSTED",
    `${path} ${problem}, so Rig will not use it.`,
    `Rig only uses files under its root that it wrote and that are private to you. Remove ${path}; Rig writes it again.`,
    { path, problem },
  );

/** FILE_NOT_DURABLE: `path` holds its new contents, but the rename may not survive a crash. A caller that promises
 * durability reports it; others may take the write as done. */
const notDurable = (path: string, error: NodeJS.ErrnoException) =>
  new RigError(
    "FILE_NOT_DURABLE",
    `${path} was replaced, but its directory could not be flushed to disk (${error.code ?? "error"}).`,
    "The new contents are in place but may not survive a crash. Check the disk, then retry.",
    { path, published: true, cause: error.code ?? "error" },
  );

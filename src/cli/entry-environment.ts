import { constants, writeSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { RigError } from "../domain/errors";
import type { UserOutput } from "./types";
/** Entrypoints acquire ambient state once and pass explicit values to the application. */
export function rigRoot(): string {
  return resolveRigRoot(process.env.RIG_ROOT, homedir());
}
/** An empty override means "not overridden"; a relative one is refused rather than silently rooting Rig in the working directory. */
export function resolveRigRoot(
  RIG_ROOT: string | undefined,
  home: string,
): string {
  if (!RIG_ROOT) return join(home, ".rig");
  if (!isAbsolute(RIG_ROOT))
    throw new RigError(
      "USAGE",
      `RIG_ROOT must be an absolute path, but it is ${JSON.stringify(RIG_ROOT)}.`,
      "Set RIG_ROOT to an absolute directory, or unset it to use ~/.rig.",
      { RIG_ROOT },
    );
  return resolve(RIG_ROOT);
}
/** Every command writes under the root (at least its diagnostic log), so a root that cannot be
 * written is reported by path before anything else runs, instead of surfacing as a generic
 * failure whose "inspect the log" hint points at a log that could not be written either. */
export async function verifyRigRoot(root: string): Promise<void> {
  const existing = await nearestExisting(root);
  if (existing === undefined) return;
  if (!existing.directory)
    throw new RigError(
      "RIG_ROOT",
      existing.path === root
        ? `The Rig root ${root} is not a directory.`
        : `The Rig root ${root} cannot be created because ${existing.path} is not a directory.`,
      "Set RIG_ROOT to a directory, or move that file aside.",
      { root, path: existing.path },
    );
  try {
    await access(existing.path, constants.W_OK | constants.X_OK);
  } catch {
    throw new RigError(
      "RIG_ROOT",
      existing.path === root
        ? `The Rig root ${root} is not writable.`
        : `The Rig root ${root} cannot be created because ${existing.path} is not writable.`,
      `Fix its permissions (chmod u+rwx ${existing.path}), or set RIG_ROOT to a writable directory.`,
      { root, path: existing.path },
    );
  }
}
/** The path itself or its nearest existing ancestor; undefined when no ancestor exists (an unmounted volume). */
async function nearestExisting(
  target: string,
): Promise<{ path: string; directory: boolean } | undefined> {
  for (let candidate = target; ; candidate = dirname(candidate)) {
    try {
      return {
        path: candidate,
        directory: (await stat(candidate)).isDirectory(),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR") {
        // An ancestor is a file; keep walking up until stat names it.
      } else if (code !== "ENOENT") throw error;
    }
    if (dirname(candidate) === candidate) return undefined;
  }
}
/** Ctrl-C policy for one command: the first interrupt cancels, the second
 * detaches from a mutation rigd is still running, and a third ends the process
 * with the conventional interrupt status in case neither was honoured. */
export function interruptLadder(exit: (code: number) => void): {
  cancel: AbortSignal;
  detach: AbortSignal;
  interrupt: () => void;
} {
  const cancel = new AbortController();
  const detach = new AbortController();
  return {
    cancel: cancel.signal,
    detach: detach.signal,
    interrupt: () => {
      if (!cancel.signal.aborted) cancel.abort();
      else if (!detach.signal.aborted) detach.abort();
      else exit(130);
    },
  };
}
/** A root problem is reported before any log or daemon record exists, so it goes straight to the terminal. */
export function reportRootFailure(error: unknown, output: UserOutput): number {
  if (!(error instanceof RigError)) throw error;
  output.error(`${error.message}\n${error.hint}\n`);
  return 1;
}
/** Terminal text is written synchronously so a reader that has gone away (a closed pipe, `| head`) is
 * seen at the write that fails: that text is dropped, onClosed runs once, and later text to that stream is
 * dropped silently. Bun's stream writes swallow EPIPE, which is why the file descriptors are written directly. */
export function userOutput(onClosed?: () => void): UserOutput {
  const closed = new Set<number>();
  const write = (fd: 1 | 2, text: string): void => {
    if (closed.has(fd)) return;
    const bytes = Buffer.from(text);
    let offset = 0;
    try {
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    } catch (error) {
      if (!isGoneReader(error)) throw error;
      closed.add(fd);
      if (closed.size === 1) onClosed?.();
    }
  };
  return {
    write: (text) => write(1, text),
    error: (text) => write(2, text),
  };
}
function isGoneReader(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPIPE" || code === "EBADF";
}
/** A launchd job must outlive package upgrades, so it records the PATH entry (usually a stable symlink) that resolves to the running executable rather than the resolved, version-specific path. */
export async function stableExecutablePath(
  execPath: string,
  PATH: string | undefined,
): Promise<string> {
  const onPath = PATH ? Bun.which(basename(execPath), { PATH }) : null;
  if (!onPath || onPath === execPath) return execPath;
  try {
    return (await realpath(onPath)) === (await realpath(execPath))
      ? onPath
      : execPath;
  } catch {
    return execPath;
  }
}
/** True when bun is running a rig entrypoint from source (`bun src/rigd.ts`), so the running executable is bun.
 * A `bun build --compile` binary is its own entrypoint, so its executable is rig or rigd, never bun. */
export function runsFromSource(entrypoint: string | undefined): boolean {
  return entrypoint?.endsWith(".ts") === true;
}
export async function daemonCommand(): Promise<readonly string[]> {
  const executable = await stableExecutablePath(
    process.execPath,
    process.env.PATH,
  );
  return runsFromSource(process.argv[1])
    ? [executable, join(import.meta.dir, "..", "rigd.ts")]
    : [join(dirname(executable), "rigd")];
}
/** The one executable a Service's command runs rigd by, which plans name as `${rig.rigd}`: the compiled rigd, or
 * src/rigd.ts when rigd runs from source, which its `#!/usr/bin/env bun` line runs with the bun on the Service's PATH. */
export function rigdExecutable(daemon: readonly string[]): string {
  return daemon.at(-1)!;
}
/** The bun that Tools whose `bin` is a source file run with, resolved once when rigd is installed: the running executable
 * when rigd runs from source, otherwise the first `bun` on the installing shell's PATH. Either way it is the stable PATH
 * entry, so a package upgrade does not strand it. Undefined when a compiled rigd finds no bun on PATH. */
export async function resolveToolBun(running: {
  readonly execPath: string;
  readonly entrypoint: string | undefined;
  readonly PATH: string | undefined;
}): Promise<string | undefined> {
  const bun = runsFromSource(running.entrypoint)
    ? running.execPath
    : running.PATH
      ? Bun.which("bun", { PATH: running.PATH })
      : null;
  return bun ? await stableExecutablePath(bun, running.PATH) : undefined;
}

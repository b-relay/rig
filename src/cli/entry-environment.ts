import { writeSync } from "node:fs";
import { realpath } from "node:fs/promises";
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
export async function daemonCommand(): Promise<readonly string[]> {
  const executable = await stableExecutablePath(
    process.execPath,
    process.env.PATH,
  );
  return process.argv[1]?.endsWith(".ts")
    ? [executable, join(import.meta.dir, "..", "rigd.ts")]
    : [join(dirname(executable), "rigd")];
}

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { UserOutput } from "./types";
/** Entrypoints acquire ambient state once and pass explicit values to the application. */
export function rigRoot(): string {
  return resolve(process.env.RIG_ROOT ?? join(homedir(), ".rig"));
}
export function userOutput(): UserOutput {
  return {
    write: (text) => {
      process.stdout.write(text);
    },
    error: (text) => {
      process.stderr.write(text);
    },
  };
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

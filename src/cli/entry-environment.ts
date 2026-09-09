import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
export function daemonCommand(): readonly string[] {
  return process.argv[1]?.endsWith(".ts")
    ? [process.execPath, join(import.meta.dir, "..", "rigd.ts")]
    : [join(dirname(process.execPath), "rigd")];
}

import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Where the launcher lives under a Rig root. Plans record this path for `${rig.rigd}`, so it must not change while the
 * root does not. */
export function rigdLauncherPath(root: string): string {
  return join(root, "daemon", "rigd");
}
/** Pure: a /bin/sh script that runs `daemon` (rigd's own command: the compiled rigd, or bun and src/rigd.ts) with the
 * script's arguments. From source, bun is told not to load the working directory's .env files, as the compiled rigd is
 * built not to: a Service helper runs in a Target's workspace, and must see only the environment Rig gave the Service. */
export function rigdLauncher(daemon: readonly string[]): string {
  const [first, ...rest] = daemon;
  const command =
    rest.length && first !== undefined
      ? [first, "--no-env-file", ...rest]
      : [...daemon];
  return `#!/bin/sh\n# Written by rigd each time it starts: the rigd this Host's Services run as \${rig.rigd}.\nexec ${command.map(quoted).join(" ")} "$@"\n`;
}
/** Writes the launcher for the rigd that is starting and returns its path. The file is replaced whole (written beside
 * itself, then renamed), so a Service starting at that moment runs either the old rigd or the new one. */
export async function writeRigdLauncher(
  root: string,
  daemon: readonly string[],
): Promise<string> {
  const path = rigdLauncherPath(root);
  await mkdir(join(root, "daemon"), { recursive: true, mode: 0o700 });
  const staged = `${path}.${process.pid}.tmp`;
  await writeFile(staged, rigdLauncher(daemon), { mode: 0o755 });
  await chmod(staged, 0o755);
  await rename(staged, path);
  return path;
}
function quoted(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

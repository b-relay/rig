import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory } from "../providers/private-files";

/** The directories rigd keeps directly under the Rig root. Each holds credentials, records rigd acts on, or programs and
 * commands it runs, so each must be the user's alone. */
const ROOT_DIRECTORIES = [
  "auth",
  "daemon",
  "runtime",
  "capture",
  "process-leases",
  "process-exits",
  "env",
  "installed",
  "bin",
  "caddy",
  "proxy",
  "dashboard",
  "logs",
  "monitor",
  "effect-checkpoints",
  "sources",
  "targets",
  "tmp",
  "data",
  "backups",
] as const;

/** Checked by `rigd install` and as rigd starts, before either writes anything: the Rig root and each of its directories that
 * exists must be a real directory the user owns that no one else can write, or RIG_ROOT_UNSAFE names it and says how to fix
 * it. Those that others can only read, as an earlier Rig left them, are made 0700, as are the root and `auth`, `daemon` and
 * `runtime`, made when missing. */
export async function securePrivateRoot(root: string): Promise<void> {
  await privateDirectory(root, root);
  // Every existing one is judged before anything is made.
  for (const name of ROOT_DIRECTORIES) {
    const path = join(root, name);
    const present = await lstat(path).then(
      () => true,
      () => false,
    );
    if (present) await privateDirectory(root, path);
  }
  for (const name of ["auth", "daemon", "runtime"])
    await privateDirectory(root, join(root, name));
}

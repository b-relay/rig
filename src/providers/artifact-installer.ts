import { constants } from "node:fs";
import { access, open, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve, extname } from "node:path";
import { replacePrivateFile } from "./private-files";
import { RigError } from "../domain/errors";
import type { CommandRunner } from "./contracts";
/** How a source-file Tool's shim begins; the bun it runs and its source follow, each quoted. */
const SHIM_START = "#!/bin/sh\nexec ";
export interface InstallRequest {
  readonly cwd: string;
  readonly entrypoint: string;
  readonly destination: string;
  readonly build?: string;
  readonly env: Readonly<Record<string, string>>;
}
export interface ArtifactInstaller {
  install(request: InstallRequest): Promise<{ path: string }>;
  observe(path: string): Promise<"installed" | "missing" | "unknown">;
  /** Names what `install` would publish for a source entrypoint (a shim), whose text depends on the installer rather than
   * on the file, so a publication receipt can tell when republishing would change it. Undefined for an entrypoint that is
   * copied as is, whose own content identifies it. */
  shimRevision(entrypoint: string): string | undefined;
}
/** Builds before replacing an installed artifact and publishes by atomic rename.
 * Builds run through `run`. A source entrypoint (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`) is published as a shim that
 * execs `bunExecutable`, the bun `rigd install` recorded, never a PATH lookup and never rigd's own executable (a compiled
 * rigd is not bun). Without a runnable `bunExecutable` such an install fails as BUN_NOT_FOUND before building or publishing,
 * and the last good artifact stays. `shimRevision` changes with `bunExecutable`, so a new recorded bun republishes shims. */
export function createArtifactInstaller(options: {
  readonly run: CommandRunner;
  readonly bunExecutable: string | undefined;
  /** The Rig root the destinations lie under; absent, a destination's own directory is taken as one. */
  readonly root?: string;
}): ArtifactInstaller {
  const { run, bunExecutable } = options;
  return {
    async install(request) {
      const source = resolve(request.cwd, request.entrypoint);
      // Checked before the build, so a Tool that could not run neither builds nor replaces the last good artifact.
      const shimBun = isSourceEntrypoint(source)
        ? await runnableBun(bunExecutable, source)
        : undefined;
      if (request.build) {
        const result = await run({
          command: ["/bin/sh", "-c", request.build],
          cwd: request.cwd,
          env: request.env,
          timeoutMs: 600_000,
        });
        if (result.exitCode !== 0)
          throw new RigError(
            "BUILD_FAILED",
            "The installed component build failed.",
            "Fix the build and retry; the previous installed artifact is unchanged.",
            { exitCode: result.exitCode, stderr: result.stderr },
          );
      }
      const sourceStat = await stat(source).catch(() => undefined);
      if (!sourceStat?.isFile())
        throw new RigError(
          "ARTIFACT_MISSING",
          "The component entrypoint is not a file.",
          "Check the build output and configured entrypoint.",
          { path: source },
        );
      // Published in Rig's shared bin, under the Rig root.
      await replacePrivateFile(
        options.root ?? dirname(request.destination),
        request.destination,
        shimBun !== undefined
          ? `${SHIM_START}${shellQuote(shimBun)} ${shellQuote(source)} "$@"\n`
          : await readFile(source),
        {
          mode:
            shimBun !== undefined ? 0o755 : (sourceStat.mode | 0o111) & 0o777,
          // On disk before an effect journal records it as published.
          durable: true,
        },
      );
      return { path: request.destination };
    },
    shimRevision(entrypoint) {
      return isSourceEntrypoint(entrypoint)
        ? `source-shim:${bunExecutable ?? ""}`
        : undefined;
    },
    async observe(path) {
      try {
        const value = await stat(path);
        if (!value.isFile()) return "missing";
        await access(path, constants.X_OK);
        return "installed";
      } catch (error) {
        return ["ENOENT", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
          ? "missing"
          : "unknown";
      }
    },
  };
}

/** The bun a source entrypoint's shim execs. A shim to a bun that is absent, not a regular file, or not executable would
 * publish a Tool that cannot run, so the install is refused as BUN_NOT_FOUND instead. */
async function runnableBun(
  bun: string | undefined,
  entrypoint: string,
): Promise<string> {
  if (bun === undefined)
    throw new RigError(
      "BUN_NOT_FOUND",
      `The Tool entrypoint ${entrypoint} is a source file, but rigd has no recorded bun to run it with (rigd install found none on PATH, or rigd started without an installation record).`,
      "Install bun so your shell's PATH finds it, then run rigd install again to record it; or build the Tool and point bin at the executable.",
      { entrypoint },
    );
  // A directory is searchable, so X_OK alone would pass it; only a regular executable file can run a Tool.
  const runnable =
    (await stat(bun).catch(() => undefined))?.isFile() === true &&
    (await access(bun, constants.X_OK).then(
      () => true,
      () => false,
    ));
  if (!runnable)
    throw new RigError(
      "BUN_NOT_FOUND",
      `The Tool entrypoint ${entrypoint} is a source file, but the bun rigd install recorded, ${bun}, is missing or not an executable file.`,
      "Run rigd install again from a shell whose PATH finds bun, so rigd records the current one.",
      { entrypoint, bun },
    );
  return bun;
}

/** Whether the executable at `path` is a source-file Tool's shim whose source lies in `directory`, which it needs for as long
 * as it stays published. A copied executable needs nothing once published, and an absent one needs nothing at all. */
export async function shimRunsFrom(
  path: string,
  directory: string,
): Promise<boolean> {
  const file = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!file) return false;
  try {
    // A shim is two short lines; the rest of a copied binary is not worth reading.
    const { buffer, bytesRead } = await file.read(
      Buffer.alloc(16_384),
      0,
      16_384,
    );
    const text = buffer.subarray(0, bytesRead).toString();
    // The source's quoted path, up to its closing quote.
    return (
      text.startsWith(SHIM_START) &&
      text.includes(` ${shellQuote(join(directory, "/")).slice(0, -1)}`)
    );
  } finally {
    await file.close();
  }
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

export function isSourceEntrypoint(path: string): boolean {
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extname(path));
}

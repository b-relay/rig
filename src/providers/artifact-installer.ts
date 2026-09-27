import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve, extname } from "node:path";
import { RigError } from "../domain/errors";
import type { CommandRunner } from "./contracts";
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
}
/** Builds before replacing an installed artifact and publishes by atomic rename.
 * Builds run through `run`. A source entrypoint (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`) is published as a shim that
 * execs `bunExecutable`, the bun `rigd install` recorded, never a PATH lookup and never rigd's own executable (a compiled
 * rigd is not bun). Without a runnable `bunExecutable` such an install fails as BUN_NOT_FOUND before building or publishing. */
export function createArtifactInstaller(options: {
  readonly run: CommandRunner;
  readonly bunExecutable: string | undefined;
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
      await mkdir(dirname(request.destination), { recursive: true });
      const temporary = `${request.destination}.${randomUUID()}.tmp`;
      try {
        if (shimBun !== undefined) {
          await writeFile(
            temporary,
            `#!/bin/sh\nexec ${shellQuote(shimBun)} ${shellQuote(source)} "$@"\n`,
            { mode: 0o755 },
          );
        } else {
          await copyFile(source, temporary);
          await chmod(temporary, sourceStat.mode | 0o111);
        }
        await rename(temporary, request.destination);
      } finally {
        await rm(temporary, { force: true });
      }
      return { path: request.destination };
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

/** The bun a source entrypoint's shim execs. A shim to a bun that is absent or not executable would publish a Tool that
 * cannot run, so the install is refused as BUN_NOT_FOUND instead. */
async function runnableBun(
  bun: string | undefined,
  entrypoint: string,
): Promise<string> {
  if (bun === undefined)
    throw new RigError(
      "BUN_NOT_FOUND",
      `The Tool entrypoint ${entrypoint} is a source file, but rigd has no bun to run it with: rigd install recorded none because it found no bun on PATH.`,
      "Install bun so your shell's PATH finds it, then run rigd install again to record it; or build the Tool and point bin at the executable.",
      { entrypoint },
    );
  try {
    await access(bun, constants.X_OK);
  } catch {
    throw new RigError(
      "BUN_NOT_FOUND",
      `The Tool entrypoint ${entrypoint} is a source file, but the bun rigd install recorded, ${bun}, is missing or not executable.`,
      "Run rigd install again from a shell whose PATH finds bun, so rigd records the current one.",
      { entrypoint, bun },
    );
  }
  return bun;
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

export function isSourceEntrypoint(path: string): boolean {
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extname(path));
}

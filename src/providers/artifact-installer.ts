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
import { runCommand } from "./command-runner";
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
/** Builds before replacing an installed artifact and publishes by atomic rename. */
export function createArtifactInstaller(
  options: {
    readonly run?: CommandRunner;
    readonly bunExecutable?: string;
  } = {},
): ArtifactInstaller {
  const run = options.run ?? runCommand;
  return {
    async install(request) {
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
      const source = resolve(request.cwd, request.entrypoint);
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
        if (isSourceEntrypoint(source)) {
          const executable = options.bunExecutable ?? Bun.which("bun");
          if (!executable)
            throw new RigError(
              "BUN_MISSING",
              "Bun is required to install this source entrypoint.",
              "Install Bun or configure its executable path.",
            );
          await writeFile(
            temporary,
            `#!/bin/sh\nexec ${shellQuote(executable)} ${shellQuote(source)} "$@"\n`,
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

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

export function isSourceEntrypoint(path: string): boolean {
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extname(path));
}

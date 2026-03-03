import { Effect, Layer } from "effect";

import { runCli } from "./cli/index";
import { BunBinInstallerLive } from "./providers/bun-bin";
import { DotenvLoaderLive } from "./providers/dotenv-loader";
import { BunGitLive } from "./providers/bun-git";
import { BunServiceRunnerLive } from "./providers/bun-service-runner";
import { CaddyProxyLive } from "./providers/caddy";
import { DispatchHealthCheckerLive } from "./providers/health-checker-dispatch";
import { JsonLoggerLive } from "./providers/json-logger";
import { LaunchdManagerLive } from "./providers/launchd";
import { NodeFileSystemLive } from "./providers/node-fs";
import { JSONRegistryLive } from "./providers/json-registry";
import { TerminalLoggerLive } from "./providers/terminal-logger";
import { GitWorktreeWorkspaceLive } from "./providers/worktree";

const loggerLayer = process.env.RIG_LOG_FORMAT === "json" ? JsonLoggerLive : TerminalLoggerLive;

const DotenvWithFileSystemLive = Layer.provide(DotenvLoaderLive, NodeFileSystemLive);
const RegistryWithFileSystemLive = Layer.provide(JSONRegistryLive, NodeFileSystemLive);
const ServiceRunnerWithFileSystemLive = Layer.provide(BunServiceRunnerLive, NodeFileSystemLive);
const BinInstallerWithFileSystemLive = Layer.provide(BunBinInstallerLive, NodeFileSystemLive);
const WorkspaceWithDependenciesLive = Layer.provide(
  GitWorktreeWorkspaceLive,
  Layer.mergeAll(BunGitLive, NodeFileSystemLive, RegistryWithFileSystemLive),
);

export const RigLive = Layer.mergeAll(
  NodeFileSystemLive,
  DotenvWithFileSystemLive,
  RegistryWithFileSystemLive,
  BunGitLive,
  CaddyProxyLive,
  LaunchdManagerLive,
  WorkspaceWithDependenciesLive,
  DispatchHealthCheckerLive,
  ServiceRunnerWithFileSystemLive,
  BinInstallerWithFileSystemLive,
  loggerLayer,
);

const isRigError = (error: unknown): error is { _tag: string; message: string; hint: string } =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  "message" in error &&
  "hint" in error &&
  typeof error._tag === "string" &&
  typeof error.message === "string" &&
  typeof error.hint === "string";

export const main = (argv: string[]): Promise<number> =>
  Effect.runPromise(
    runCli(argv).pipe(
      Effect.provide(RigLive),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          if (isRigError(error)) {
            console.error(`✗ [${error._tag}] ${error.message}`);
            console.error(`  Hint: ${error.hint}`);
          } else {
            console.error("✗ unexpected error");
          }

          return 1;
        }),
      ),
    ),
  );

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exitCode = exitCode;
}

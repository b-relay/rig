import { Effect, Layer } from "effect";

import { runCli } from "./cli/index";
import { Logger } from "./interfaces/logger.js";
import { BunBinInstallerLive } from "./providers/bun-bin";
import { BunHookRunnerLive } from "./providers/bun-hook-runner";
import { BunPortCheckerLive } from "./providers/bun-port-checker";
import { DotenvLoaderLive } from "./providers/dotenv-loader";
import { BunGitLive } from "./providers/bun-git";
import { BunServiceRunnerLive } from "./providers/bun-service-runner";
import { CaddyProxyLive } from "./providers/caddy";
import { DispatchHealthCheckerLive } from "./providers/health-checker-dispatch";
import { JsonLoggerLive } from "./providers/json-logger";
import { LaunchdManagerLive } from "./providers/launchd";
import { NodeFileSystemLive } from "./providers/node-fs";
import { JSONRegistryLive } from "./providers/json-registry";
import { CompositeLoggerLive } from "./providers/composite-logger";
import { FileLoggerLive } from "./providers/file-logger";
import { TerminalLoggerLive } from "./providers/terminal-logger";
import { GitWorktreeWorkspaceLive } from "./providers/worktree";
import type { RigError } from "./schema/errors.js";

export const buildLoggerLayer = (): Layer.Layer<Logger> => {
  const primaryLayer = process.env.RIG_LOG_FORMAT === "json" ? JsonLoggerLive : TerminalLoggerLive
  const logFilePath = process.env.RIG_LOG_FILE

  if (!logFilePath) {
    return primaryLayer
  }

  return CompositeLoggerLive(
    primaryLayer,
    Layer.provide(FileLoggerLive(logFilePath), NodeFileSystemLive),
  )
}

const loggerLayer = buildLoggerLayer()

const DotenvWithFileSystemLive = Layer.provide(DotenvLoaderLive, NodeFileSystemLive);
const RegistryWithFileSystemLive = Layer.provide(JSONRegistryLive, NodeFileSystemLive);
const ServiceRunnerWithFileSystemLive = Layer.provide(
  BunServiceRunnerLive,
  Layer.mergeAll(NodeFileSystemLive, loggerLayer),
);
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
  BunHookRunnerLive,
  BunPortCheckerLive,
  CaddyProxyLive,
  LaunchdManagerLive,
  WorkspaceWithDependenciesLive,
  DispatchHealthCheckerLive,
  ServiceRunnerWithFileSystemLive,
  BinInstallerWithFileSystemLive,
  loggerLayer,
);

const isRigError = (error: unknown): error is RigError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  "message" in error &&
  "hint" in error &&
  typeof error._tag === "string" &&
  typeof error.message === "string" &&
  typeof error.hint === "string";

const isTaggedMessageError = (error: unknown): error is { _tag: string; message: string } =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  "message" in error &&
  typeof error._tag === "string" &&
  typeof error.message === "string";

const stringifyUnknown = (value: unknown): string => {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
};

const renderUnexpectedErrorDetails = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }

  if (isTaggedMessageError(error)) {
    return {
      tag: error._tag,
      message: error.message,
    };
  }

  return {
    value: stringifyUnknown(error),
  };
};

export const main = (argv: string[]): Promise<number> =>
  Effect.runPromise(
    runCli(argv).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const logger = yield* Logger;

          if (isRigError(error)) {
            yield* logger.error(error);
          } else {
            yield* logger.warn("Unexpected error while running command.", renderUnexpectedErrorDetails(error));
          }

          return 1;
        }),
      ),
      Effect.provide(RigLive),
    ),
  );

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exitCode = exitCode;
}

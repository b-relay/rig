import { Effect, Layer } from "effect";

import { runCli } from "./cli/index";
import { DotenvLoaderLive } from "./providers/dotenv-loader";
import { BunGitLive } from "./providers/bun-git";
import { JsonLoggerLive } from "./providers/json-logger";
import { NodeFileSystemLive } from "./providers/node-fs";
import { JSONRegistryLive } from "./providers/json-registry";
import { StubBinInstallerLive } from "./providers/stub-bin-installer";
import { StubHealthCheckerLive } from "./providers/stub-health-checker";
import { StubProcessManagerLive } from "./providers/stub-process-manager";
import { StubReverseProxyLive } from "./providers/stub-reverse-proxy";
import { StubServiceRunnerLive } from "./providers/stub-service-runner";
import { TerminalLoggerLive } from "./providers/terminal-logger";
import { StubWorkspaceLive } from "./providers/stub-workspace";

const loggerLayer = process.env.RIG_LOG_FORMAT === "json" ? JsonLoggerLive : TerminalLoggerLive;

const DotenvWithFileSystemLive = Layer.provide(DotenvLoaderLive, NodeFileSystemLive);
const RegistryWithFileSystemLive = Layer.provide(JSONRegistryLive, NodeFileSystemLive);

export const RigLive = Layer.mergeAll(
  NodeFileSystemLive,
  DotenvWithFileSystemLive,
  RegistryWithFileSystemLive,
  BunGitLive,
  StubReverseProxyLive,
  StubProcessManagerLive,
  StubWorkspaceLive,
  StubHealthCheckerLive,
  StubServiceRunnerLive,
  StubBinInstallerLive,
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

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

export const main = (argv: string[]): Promise<number> =>
  Effect.runPromise(
    runCli(argv).pipe(
      Effect.provide(RigLive),
    ),
  );

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exitCode = exitCode;
}

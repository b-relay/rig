import { Effect } from "effect-v3";

import { runCli } from "./cli/index";
import { Logger } from "./interfaces/logger.js"
import { buildRigLayer } from "./provider-profiles.js"
import { runInternalLogCapture } from "./providers/internal-log-capture";
import type { RigError } from "./schema/errors.js";

export { buildLoggerLayer, buildRigLayer, normalizeRigProviderProfile } from "./provider-profiles.js"

const normalizeArgv = (
  argv: readonly string[],
): {
  readonly argv: readonly string[];
  readonly verbose: boolean;
  readonly json: boolean;
} => {
  const filtered = argv.filter((arg) => arg !== "--verbose" && arg !== "--json");
  return {
    argv: filtered,
    verbose: argv.includes("--verbose"),
    json: argv.includes("--json"),
  };
};

export const RigLive = buildRigLayer();

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
  argv[0] === "_capture-logs"
    ? runInternalLogCapture(argv.slice(1))
    : Effect.runPromise(
        (Effect.gen(function* () {
          const normalized = normalizeArgv(argv)

          return yield* runCli(normalized.argv).pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                const logger = yield* Logger

                if (isRigError(error)) {
                  yield* logger.error(error)
                } else {
                  yield* logger.warn(
                    "Unexpected error while running command.",
                    renderUnexpectedErrorDetails(error),
                  )
                }

                return 1
              }),
            ),
            Effect.provide(buildRigLayer(normalized.verbose, normalized.json) as never),
          )
        }) as Effect.Effect<number, never, never>),
      );

const handleSignal = (signal: string) => {
  // Outside Effect runtime — console.error is the only output available.
  console.error(`\n✗ Received ${signal}. Shutting down.`);
  process.exit(130);
};

process.on("SIGTERM", () => handleSignal("SIGTERM"));
process.on("SIGINT", () => handleSignal("SIGINT"));

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exitCode = exitCode;
}

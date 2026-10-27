import type { PublicInput } from "../config/references";
import { RigError } from "./errors";

/** The prefix of the variables that carry references' values into shell commands. Rig reserves it: no `environment` key
 * or env-file name may start with it, so no value of the author's or operator's is ever replaced by one. */
export const REFERENCE_VARIABLE_PREFIX = "_RIG_";
/** Why a name with REFERENCE_VARIABLE_PREFIX is refused, for every place that refuses one. */
export const RESERVED_NAME_RULE = `names starting with ${REFERENCE_VARIABLE_PREFIX} are reserved for the variables that carry references into shell commands`;

/** `env` without the variables that carry references' values: the environment the same command gets from a plan with its
 * values written into its commands (see `withValuesWritten`). */
export function withoutReferenceVariables(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !name.startsWith(REFERENCE_VARIABLE_PREFIX),
    ),
  );
}

/** One env file's parsed contents, held only while an invocation is composed. */
export interface LoadedEnvFile {
  path: string;
  values: Readonly<Record<string, string>>;
}
/** A name more than one source supplies; `sources` runs lowest to highest precedence, so the last one wins. Never carries values. */
export interface EnvOverride {
  key: string;
  sources: string[];
}
export interface ComposedEnvironment {
  env: Record<string, string>;
  overrides: EnvOverride[];
  /** Every value an env file supplies, which output Rig keeps or shows beyond the Target logs must not carry. */
  secrets: string[];
}
/** Composes one invocation's process environment: the controlled baseline, then public env, then each file in order.
 * A public env leaf the invocation's commands were built from (`guarded`) may not get a different final value from a file,
 * because the command text and the process environment would then disagree; an equal value is no conflict.
 * Throws RigError ENV_CONFLICT naming the key, the Component and the competing sources, never a value. */
export function composeEnvironment(input: {
  baseline: Readonly<Record<string, string>>;
  publicEnv: Readonly<Record<string, string>>;
  files: readonly LoadedEnvFile[];
  guarded: readonly PublicInput[];
  component?: string;
}): ComposedEnvironment {
  const supplying = (key: string) =>
    input.files.filter((file) => Object.hasOwn(file.values, key));
  for (const leaf of input.guarded) {
    const winner = supplying(leaf.name).at(-1);
    if (winner && winner.values[leaf.name] !== leaf.value)
      throw new RigError(
        "ENV_CONFLICT",
        `${winner.path} changes ${leaf.name}, but a command of ${input.component ?? "the Project"} was already built from the public value at ${leaf.source}.`,
        `The command text and the process environment would disagree. Remove ${leaf.name} from the file, make both values equal, or have the command read $${leaf.name} from the environment instead of \${${leaf.source}}.`,
        {
          key: leaf.name,
          ...(input.component ? { component: input.component } : {}),
          sources: [leaf.source, winner.path],
        },
      );
  }
  const keys = new Set(input.files.flatMap((file) => Object.keys(file.values)));
  const overrides = [...keys]
    .sort()
    .map((key) => ({
      key,
      sources: [
        ...(Object.hasOwn(input.publicEnv, key) ? ["env"] : []),
        ...supplying(key).map((file) => file.path),
      ],
    }))
    .filter((override) => override.sources.length > 1);
  return {
    env: Object.assign(
      {},
      input.baseline,
      input.publicEnv,
      ...input.files.map((file) => file.values),
    ),
    overrides,
    secrets: input.files.flatMap((file) => Object.values(file.values)),
  };
}

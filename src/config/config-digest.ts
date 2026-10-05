import { createHash } from "node:crypto";
import type { ProjectConfig } from "./types";

/** Pure: a SHA-256 of what a parsed Project config says. It ignores how the file spells it (its comments and layout, and
 * the order of a Service's own settings, which the parser gives in one order), but not the order of entries in
 * a map such as `services`, which decides the order Rig starts them in. Two files that parse to the same config share it. */
export function configDigest(config: ProjectConfig): string {
  return digestOf(config);
}
/** Pure: whether `recorded` is the digest of what `config` says. A digest a rigd recorded before ADR 0011 renamed `run` to
 * `command` and `env` to `environment` was taken under the old names, so it is also compared with `config` spelled that
 * way: renaming the keys of an unchanged rig.yaml is no change of what it says. */
export function sameConfigDigest(
  config: ProjectConfig,
  recorded: string,
): boolean {
  return (
    recorded === digestOf(config) ||
    recorded === digestOf(preComposeSpelling(config))
  );
}
function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
type Tree = Record<string, unknown>;
const isTree = (value: unknown): value is Tree =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** `config` as a rigd before ADR 0011 parsed the same file: each key keeps its place under its old name, and every
 * reference through `environment` is written through `env`. */
function preComposeSpelling(config: ProjectConfig): unknown {
  const text = (value: string) =>
    value.replace(
      /\$\{(\s*)((?:services\.[^.}]+\.)?)environment\./g,
      (_match, space: string, owner: string) => `\${${space}${owner}env.`,
    );
  const walk = (value: unknown, path: readonly string[]): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map((item) => walk(item, path));
    if (!isTree(value)) return value;
    const settings =
      path.length === 0 || (path.length === 2 && path[0] === "targets");
    const service =
      (path.length === 2 && path[0] === "services") ||
      (path.length === 4 && path[0] === "targets" && path[2] === "services");
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        (settings || service) && key === "environment"
          ? "env"
          : service && key === "command"
            ? "run"
            : key,
        walk(child, [...path, key]),
      ]),
    );
  };
  return walk(config, []);
}

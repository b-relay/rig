import type { EnvFileView, EnvScope, TargetReport } from "./types";

/** Pure: one string naming a scope, for the URL and for keys: `<service>:<role>`, `:all` for the Project's all.env. */
export const scopeKey = (scope: EnvScope): string =>
  `${scope.service ?? ""}:${scope.role ?? "all"}`;
/** Pure: the scope a `scopeKey` names; anything malformed names the Project's all.env. */
export function parseScopeKey(key: string | undefined): EnvScope {
  const match =
    /^([a-zA-Z0-9][a-zA-Z0-9_-]*)?:(all|working|stable|preview)$/.exec(
      key ?? "",
    );
  if (!match) return {};
  return {
    ...(match[1] ? { service: match[1] } : {}),
    ...(match[2] !== "all"
      ? { role: match[2] as "working" | "stable" | "preview" }
      : {}),
  };
}
/** Pure: the file a scope names, relative to the Project's env directory, such as `web/stable.env`. */
export const scopeFile = (scope: EnvScope): string =>
  `${scope.service ? `${scope.service}/` : ""}${scope.role ?? "all"}.env`;
/** Pure: who reads a scope's file, in a few words. */
export function scopeReaders(scope: EnvScope): string {
  const who = scope.service
    ? `the ${scope.service} Service`
    : "every Service and Tool";
  const where = scope.role
    ? scope.role === "preview"
      ? "every Preview"
      : `the ${scope.role} Target`
    : "every Target";
  return `Read by ${who} of ${where}.`;
}
/** One name a Target's process environment gets from the operator files, and where from. */
export interface LayeredKey {
  key: string;
  /** The file whose value wins: the last in layering order that assigns it. */
  from: EnvScope;
  /** Lower files that also assign it and lose. */
  shadows: EnvScope[];
}
/** Pure: the names a Service of a Target with `role` gets from operator files, in the order resolve.ts
 * layers them (the Project's all.env, its role file, the Service's all.env, its role file), each with
 * the file that wins. Without a Service, the Project files alone, as a Tool gets them. */
export function layeredKeys(
  files: readonly EnvFileView[],
  role: "working" | "stable" | "preview",
  service?: string,
): LayeredKey[] {
  const chain: EnvScope[] = [
    {},
    { role },
    ...(service ? [{ service }, { service, role }] : []),
  ];
  const found = new Map<string, LayeredKey>();
  for (const scope of chain) {
    const file = files.find((each) => scopeKey(each.scope) === scopeKey(scope));
    for (const key of file?.keys ?? []) {
      const before = found.get(key);
      found.set(key, {
        key,
        from: scope,
        shadows: before ? [...before.shadows, before.from] : [],
      });
    }
  }
  return [...found.values()].sort((a, b) => a.key.localeCompare(b.key));
}
/** Pure: the Targets that read a scope's file when they start, so a change reaches them on their next restart. */
export function readersOf(
  scope: EnvScope,
  targets: readonly Pick<
    TargetReport,
    "name" | "kind" | "state" | "components"
  >[],
): Pick<TargetReport, "name" | "kind" | "state">[] {
  return targets.filter(
    (target) =>
      (!scope.role || target.kind === scope.role) &&
      (!scope.service ||
        target.components.some(
          (component) => component.name === scope.service,
        )),
  );
}

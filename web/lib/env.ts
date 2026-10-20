import type { EnvFileView, EnvScope, TargetReport } from "./types";

/** A Service or a Job: whoever owns the env files below the Project's own. */
export type EnvOwner = { service: string } | { job: string };
/** Pure: one string naming a scope, for the URL and for keys: `<service or job>:<role>`, `:all` for the Project's
 * all.env. A Service and a Job never share a name, so the key names one file. */
export const scopeKey = (scope: EnvScope): string =>
  `${scope.service ?? scope.job ?? ""}:${scope.role ?? "all"}`;
/** Pure: the file of `files` a `scopeKey` names; anything else names the first, the Project's all.env. */
export function fileNamed(
  files: readonly EnvFileView[],
  key: string | undefined,
): EnvFileView {
  return files.find((each) => scopeKey(each.scope) === key) ?? files[0]!;
}
/** Pure: the file a scope names, relative to the Project's env directory, such as `web/stable.env`. */
export const scopeFile = (scope: EnvScope): string => {
  const owner = scope.service ?? scope.job;
  return `${owner ? `${owner}/` : ""}${scope.role ?? "all"}.env`;
};
/** Pure: who reads a scope's file, in a few words. */
export function scopeReaders(scope: EnvScope): string {
  const where = scope.role
    ? scope.role === "preview"
      ? "every Preview"
      : `the ${scope.role} Target`
    : "every Target";
  if (scope.job)
    return `Read by every run of the ${scope.job} Job, and its restores, in ${where}.`;
  const who = scope.service
    ? `the ${scope.service} Service`
    : "every Service, Tool and Job";
  return `Read by ${who} of ${where}.`;
}
/** One name a Target's process environment gets from the operator files, and where from. */
export interface LayeredKey {
  key: string;
  /** The file whose value wins: the last in layering order that assigns it. */
  from: EnvScope;
  /** The revision of that file, which a value revealed from it must have been read from. */
  revision: string;
  /** Lower files that also assign it and lose. */
  shadows: EnvScope[];
}
/** Pure: the names a Service or Job of a Target with `role` gets from operator files, in the order resolve.ts
 * layers them (the Project's all.env, its role file, the owner's all.env, its role file), each with the file that
 * wins. Without an owner, the Project files alone, as a Tool gets them. */
export function layeredKeys(
  files: readonly EnvFileView[],
  role: "working" | "stable" | "preview",
  owner?: EnvOwner,
): LayeredKey[] {
  const chain: EnvScope[] = [
    {},
    { role },
    ...(owner ? [owner, { ...owner, role }] : []),
  ];
  const found = new Map<string, LayeredKey>();
  for (const scope of chain) {
    const file = files.find((each) => scopeKey(each.scope) === scopeKey(scope));
    for (const key of file?.keys ?? []) {
      const before = found.get(key);
      found.set(key, {
        key,
        from: scope,
        revision: file!.revision,
        shadows: before ? [...before.shadows, before.from] : [],
      });
    }
  }
  return [...found.values()].sort((a, b) => a.key.localeCompare(b.key));
}
/** Pure: the Targets that read a scope's file when they start, so a change reaches them on their next restart. A Job's
 * file is read afresh by each run and restore, so none needs one. */
export function readersOf(
  scope: EnvScope,
  targets: readonly Pick<
    TargetReport,
    "name" | "kind" | "state" | "components"
  >[],
): Pick<TargetReport, "name" | "kind" | "state">[] {
  if (scope.job) return [];
  return targets.filter(
    (target) =>
      (!scope.role || target.kind === scope.role) &&
      (!scope.service ||
        target.components.some(
          (component) => component.name === scope.service,
        )),
  );
}
/** The entry `record` holds for `key` itself, so a name such as constructor or toString never reads an inherited property. */
export function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

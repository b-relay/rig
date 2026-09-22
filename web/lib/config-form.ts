import type { ConfigField, ConfigPatch } from "./types";

/** A parsed rig.yaml as the editor holds it: plain JSON values, never class instances. */
export type Tree = Record<string, unknown>;
export const isTree = (value: unknown): value is Tree =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export function getAt(tree: unknown, path: readonly string[]): unknown {
  let value = tree;
  for (const key of path) {
    if (!isTree(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
/** A copy of `tree` with `value` at `path`; missing objects on the way are created. */
export function setAt(
  tree: Tree,
  path: readonly string[],
  value: unknown,
): Tree {
  const [key, ...rest] = path;
  if (key === undefined) return tree;
  const current = tree[key];
  return {
    ...tree,
    [key]: rest.length
      ? setAt(isTree(current) ? current : {}, rest, value)
      : value,
  };
}
/** A copy of `tree` without `path`; objects emptied by the removal go too, so a cleared `env` leaves no `env: {}` behind. */
export function removeAt(tree: Tree, path: readonly string[]): Tree {
  const [key, ...rest] = path;
  if (key === undefined || !Object.hasOwn(tree, key)) return tree;
  const current = tree[key];
  if (rest.length) {
    if (!isTree(current)) return tree;
    const next = removeAt(current, rest);
    if (Object.keys(next).length) return { ...tree, [key]: next };
  }
  const { [key]: _gone, ...kept } = tree;
  return kept;
}
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (isTree(a) && isTree(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}
/** The smallest edit list that turns `original` into `draft`: whole subtrees are set or removed at the
 * highest path where one side is absent; shared objects are compared key by key; scalars and arrays
 * are leaves. Empty when nothing changed. */
export function configPatch(
  original: unknown,
  draft: unknown,
  path: string[] = [],
): ConfigPatch[] {
  if (deepEqual(original, draft)) return [];
  if (draft === undefined) return [{ op: "remove", path }];
  if (original === undefined || !isTree(original) || !isTree(draft))
    return [{ op: "set", path, value: draft ?? null }];
  const keys = [...new Set([...Object.keys(original), ...Object.keys(draft)])];
  return keys.flatMap((key) =>
    configPatch(original[key], draft[key], [...path, key]),
  );
}
/** `tree` with `patch` replayed onto it, so edits made against an older read carry over to a newer one. */
export function applyPatch(tree: Tree, patch: readonly ConfigPatch[]): Tree {
  return patch.reduce(
    (current, edit) =>
      edit.op === "remove"
        ? removeAt(current, edit.path)
        : setAt(current, edit.path, edit.value),
    tree,
  );
}
/** The documented field for a concrete path, matching record keys against `*`; an exact segment wins over a wildcard. */
export function fieldFor(
  fields: readonly ConfigField[],
  path: readonly string[],
): ConfigField | undefined {
  let best: { field: ConfigField; exact: number } | undefined;
  for (const field of fields) {
    const pattern = field.path.split(".");
    if (pattern.length !== path.length) continue;
    let exact = 0;
    let matches = true;
    for (let i = 0; i < pattern.length && matches; i++) {
      if (pattern[i] === path[i]) exact++;
      else if (pattern[i] !== "*") matches = false;
    }
    if (matches && (!best || exact > best.exact)) best = { field, exact };
  }
  return best?.field;
}
/** Names valid as config record keys: lowercase, digits and dashes, starting with a letter or digit. */
export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** Whether `key` may be added to the record at `pattern`: it must match, be new, and not be one of the
 * names rigd refuses in any edit path because they alias object internals. */
export function keyAllowed(
  pattern: RegExp,
  key: string,
  taken: readonly string[],
): boolean {
  return (
    pattern.test(key) &&
    !taken.includes(key) &&
    !["__proto__", "prototype", "constructor"].includes(key)
  );
}
/** A port field accepts `auto` or a number; an empty entry reads as `auto`. */
export function parsePort(text: string): "auto" | number | string {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "auto") return "auto";
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}
/** A comma-separated list as its items; empty when the text has none. */
export const parseList = (text: string): string[] =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
/** `env_file` is one path or several: a single line stays a string, more become a list. */
export function parseLines(text: string): string | string[] | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 0 ? undefined : lines.length === 1 ? lines[0] : lines;
}
export const showLines = (value: unknown): string =>
  Array.isArray(value)
    ? value.map(String).join("\n")
    : typeof value === "string"
      ? value
      : "";

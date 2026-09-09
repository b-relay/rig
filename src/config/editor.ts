import { isMap, isSeq, isScalar, isNode, visit, type Document } from "yaml";
import { ConfigError } from "./errors.js";

export type ConfigEdit =
  | { op?: "set"; path: readonly string[]; value: unknown }
  | { op: "remove"; path: readonly string[] };

export function validateEditPath(path: readonly string[]): void {
  if (
    !path.length ||
    path.some(
      (key) => !key || ["__proto__", "prototype", "constructor"].includes(key),
    )
  )
    throw new ConfigError("Unsafe or empty config edit path.", "invalid_edit");
}

/** Changes an already validated YAML tree without replacing existing collections or dropping comments. */
export function applyYamlEdits(
  document: Document,
  edits: readonly ConfigEdit[],
): void {
  for (const edit of edits) {
    validateEditPath(edit.path);
    const path = [...edit.path];
    const existing = document.getIn(path, true);
    if (isMap(existing) || isSeq(existing))
      throw new ConfigError(
        "Replacing a YAML mapping or sequence could lose comments.",
        "lossy_edit",
        {},
        "Edit individual fields inside the mapping instead.",
      );
    if (edit.op === "remove") {
      if (!document.hasIn(path)) continue;
      const parent = document.getIn(path.slice(0, -1), true);
      const pair = isMap(parent)
        ? parent.items.find(
            (item) => isScalar(item.key) && item.key.value === path.at(-1),
          )
        : undefined;
      let commented = false;
      if (pair)
        for (const child of [pair.key, pair.value])
          if (isNode(child))
            visit(child, (_key, node) => {
              if (
                node &&
                typeof node === "object" &&
                (("comment" in node && node.comment) ||
                  ("commentBefore" in node && node.commentBefore))
              )
                commented = true;
            });
      if (commented)
        throw new ConfigError(
          "Removing this YAML field would discard its comments.",
          "lossy_edit",
          {},
          "Move or remove attached comments in your editor before removing this field.",
        );
      document.deleteIn(path);
    } else document.setIn(path, edit.value);
  }
}

/** Mutates a private JSON object; callers validate the complete resulting document before writing. */
export function applyJsonEdits(
  config: Record<string, unknown>,
  edits: readonly ConfigEdit[],
): void {
  for (const edit of edits) {
    validateEditPath(edit.path);
    let cursor: Record<string, unknown> | undefined = config;
    for (const key of edit.path.slice(0, -1)) {
      if (cursor[key] === undefined) {
        if (edit.op === "remove") {
          cursor = undefined;
          break;
        }
        cursor[key] = {};
      }
      const next: unknown = cursor[key];
      if (typeof next !== "object" || next === null || Array.isArray(next))
        throw new ConfigError("Edit path is not an object.", "invalid_edit");
      cursor = next as Record<string, unknown>;
    }
    if (!cursor) continue;
    if (edit.op === "remove") delete cursor[edit.path.at(-1)!];
    else cursor[edit.path.at(-1)!] = edit.value;
  }
}

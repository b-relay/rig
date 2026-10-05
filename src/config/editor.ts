import { isMap, isSeq, isScalar, isNode, visit, type Document } from "yaml";
import { ConfigError } from "./errors";

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

/** Whether the node or anything inside it carries a comment. */
function hasComments(node: unknown): boolean {
  let commented = false;
  if (isNode(node))
    visit(node, (_key, child) => {
      if (
        child &&
        typeof child === "object" &&
        (("comment" in child && child.comment) ||
          ("commentBefore" in child && child.commentBefore))
      )
        commented = true;
    });
  return commented;
}

/** Changes an already validated YAML tree without dropping comments: a mapping or sequence is
 * replaced or removed only while nothing inside it is commented. */
export function applyYamlEdits(
  document: Document,
  edits: readonly ConfigEdit[],
): void {
  for (const edit of edits) {
    validateEditPath(edit.path);
    const path = [...edit.path];
    const existing = document.getIn(path, true);
    if ((isMap(existing) || isSeq(existing)) && hasComments(existing))
      throw new ConfigError(
        "Replacing a commented YAML mapping or sequence would lose its comments.",
        "lossy_edit",
        {},
        "Edit individual fields inside the mapping instead, or move the comments in your editor first.",
      );
    if (edit.op === "remove") {
      if (!document.hasIn(path)) continue;
      const parent = document.getIn(path.slice(0, -1), true);
      const pair = isMap(parent)
        ? parent.items.find(
            (item) => isScalar(item.key) && item.key.value === path.at(-1),
          )
        : undefined;
      if (pair && (hasComments(pair.key) || hasComments(pair.value)))
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

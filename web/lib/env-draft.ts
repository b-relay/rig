import { own, scopeKey } from "./env";
import type { EnvChange, EnvFileView, EnvScope } from "./types";

/** One staged change to a name. */
export type Pending = { op: "set"; value: string } | { op: "remove" };
/** A value an operator revealed, with the file and revision it was read from. */
export interface Revealed {
  value: string;
  /** The `scopeKey` of the file it was read from. */
  file: string;
  revision: string;
}
/** What the editor holds of one env file between reads: the changes staged, the file as it was when the first of
 * them was staged, and the values revealed. A refresh replaces the file the page shows, never this. */
export interface EnvDraft {
  pending: Record<string, Pending>;
  /** The file the pending changes were made against; absent while nothing is staged. A save names its revision. */
  base?: EnvFileView;
  revealed: Record<string, Revealed>;
}
export const EMPTY_DRAFT: EnvDraft = { pending: {}, revealed: {} };

/** Pure: the draft with `key`'s change staged, or undone when `change` is undefined. `file` is the file shown now and
 * `madeOn` the one shown when the change began (see EnvEdit), which the first staged change takes as the draft's base.
 * A change begun on another file than the base makes the draft stale against `file` whichever of the two `file` is, so
 * it is reviewed against the current file before it can be saved. */
export function stage(
  draft: EnvDraft,
  file: EnvFileView,
  key: string,
  change: Pending | undefined,
  madeOn: EnvFileView = file,
): EnvDraft {
  const { [key]: _old, ...kept } = draft.pending;
  const pending = change ? { ...kept, [key]: change } : kept;
  if (!Object.keys(pending).length)
    return { pending, revealed: draft.revealed };
  const base =
    !draft.base ||
    (draft.base.revision !== madeOn.revision &&
      draft.base.revision === file.revision)
      ? madeOn
      : draft.base;
  return { ...draft, pending, base };
}
/** A value being typed for a name, with the file shown when the typing began: the file it is made against. */
export interface EnvEdit {
  key: string;
  value: string;
  base: EnvFileView;
}
/** Pure: an edit of `key` that begins on `file`, the file shown now. */
export const beginEdit = (
  file: EnvFileView,
  key: string,
  value = "",
): EnvEdit => ({ key, value, base: file });
/** Pure: the edit's value staged against the file it began on, so a refresh while it was typed leaves the draft stale
 * against the newer file rather than made on it. */
export const keepEdit = (
  draft: EnvDraft,
  edit: EnvEdit,
  file: EnvFileView,
): EnvDraft =>
  stage(draft, file, edit.key, { op: "set", value: edit.value }, edit.base);
/** Pure: the draft without its staged changes. */
export const discard = (draft: EnvDraft): EnvDraft => ({
  pending: {},
  revealed: draft.revealed,
});
/** Pure: the staged changes moved onto `file`, once the operator has seen how it differs from their base. */
export const rebase = (draft: EnvDraft, file: EnvFileView): EnvDraft =>
  draft.base ? { ...draft, base: file } : draft;
/** Pure: the changes to send, in the order they were staged. */
export const draftChanges = (draft: EnvDraft): EnvChange[] =>
  Object.entries(draft.pending).map(([key, change]) =>
    change.op === "set"
      ? { op: "set", key, value: change.value }
      : { op: "remove", key },
  );
/** Pure: the write that saves the draft: against its base's revision, so a file that moved since is refused by rigd
 * rather than overwritten. */
export function saveRequest(
  project: string,
  draft: EnvDraft,
  file: EnvFileView,
) {
  return {
    action: "write" as const,
    project,
    scope: file.scope,
    expectedRevision: (draft.base ?? file).revision,
    changes: draftChanges(draft),
  };
}
/** Pure: how `file` differs, by name, from the base the staged changes were made against; undefined while it has
 * not moved. A value can change under the same name too, which names alone cannot show. */
export function drift(
  draft: EnvDraft,
  file: EnvFileView,
): { added: string[]; removed: string[] } | undefined {
  if (!draft.base || draft.base.revision === file.revision) return undefined;
  const base = draft.base;
  return {
    added: file.keys.filter((key) => !base.keys.includes(key)),
    removed: base.keys.filter((key) => !file.keys.includes(key)),
  };
}
/** Pure: `revealed` with `key`'s value, kept only when it was read from the revision of the file shown, so a reply
 * that arrives after a refresh, or reads a file the page has not, never shows. */
export function keepReveal(
  revealed: Record<string, Revealed>,
  key: string,
  scope: EnvScope,
  shown: string,
  reply: { value: string; revision: string },
): Record<string, Revealed> {
  if (reply.revision !== shown) return revealed;
  return {
    ...revealed,
    [key]: { value: reply.value, file: scopeKey(scope), revision: shown },
  };
}
/** Pure: `key`'s revealed value if it was read from the file and revision shown now; otherwise it is masked. */
export function revealedValue(
  revealed: Record<string, Revealed>,
  key: string,
  scope: EnvScope,
  revision: string,
): string | undefined {
  const entry = own(revealed, key);
  return entry && entry.file === scopeKey(scope) && entry.revision === revision
    ? entry.value
    : undefined;
}
/** Pure: `revealed` without the values no name shown now would show, so an old value does not stay in memory. */
export function currentReveals(
  revealed: Record<string, Revealed>,
  shown: readonly { key: string; from: EnvScope; revision: string }[],
): Record<string, Revealed> {
  return Object.fromEntries(
    shown.flatMap(({ key, from, revision }) =>
      revealedValue(revealed, key, from, revision) === undefined
        ? []
        : [[key, own(revealed, key)!]],
    ),
  );
}

import { createHash } from "node:crypto";
import type { TargetRecord } from "./runtime";

/** The name Rig generates for a Branch's Preview: a slug of the Branch and eight hex digits of its hash. */
export function generatedPreviewName(branch: string): string {
  const slug =
    branch
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "branch";
  return `${slug}-${createHash("sha256").update(branch).digest("hex").slice(0, 8)}`;
}
/** `word` as one shell word a printed command can be copied with: bare when every character is plain, otherwise
 * single-quoted, since a Branch may hold characters the shell would read, such as `(`, `$`, a space, or a leading `=`,
 * which zsh expands to a command's path. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:@%+,-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", "'\\''")}'`;
}
/** Whether `preview <branch>` selects this Preview: its name is the one Rig generates for its Branch. */
const selectedByBranch = (target: Pick<TargetRecord, "name" | "branch">) =>
  target.branch !== undefined &&
  generatedPreviewName(target.branch) === target.name;

/** The words that select `target` on the rig command line, for a hint to print: its role for the working and stable
 * Targets, and for a Preview `preview <branch>`, or `preview --deployment <name>` when an explicit name was given. A hint
 * never leaves the Target out, since a bare lifecycle command means the working Target. */
export function targetSelector(
  target: Pick<TargetRecord, "kind" | "name" | "branch">,
): string {
  if (target.kind !== "preview") return target.kind;
  return selectedByBranch(target)
    ? `preview ${shellWord(target.branch!)}`
    : `preview --deployment ${target.name}`;
}
/** The words that deploy `target` again: `stable`, or for a Preview its Branch, with its explicit name when it has one,
 * since `rig deploy preview --deployment <name>` alone would deploy the current Branch. */
export function deploySelector(
  target: Pick<TargetRecord, "kind" | "name" | "branch">,
): string {
  if (target.kind !== "preview") return target.kind;
  if (selectedByBranch(target)) return `preview ${shellWord(target.branch!)}`;
  return `preview ${target.branch ? `${shellWord(target.branch)} ` : ""}--deployment ${target.name}`;
}

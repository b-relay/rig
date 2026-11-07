/** The one rule for the names a Project and a Preview are given: by `rig init`, `rig rename`, rig.yaml and a Preview deploy.
 * A name is a selector (`--project`, `--deployment`, the control plane), a directory under `<RIG_ROOT>/env`, and part of
 * each Tool path in `<RIG_ROOT>/bin`, so it must fit all three. */

/** The longest name: the most a selector carries. */
export const MAX_NAME_LENGTH = 128;
/** The characters a name may hold, and what a name that breaks a rule is told. The rule has no schema here, so the command
 * line checks a name without loading zod; `nameSchema` in the config schema is built from it. */
export const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export const NAME_CHARACTERS =
  "must start with a letter or digit and contain only letters, digits, '_' or '-'";
export const NAME_LENGTH = `must be at most ${MAX_NAME_LENGTH} characters`;
/** Names no new Preview may take, in any case: `working` and `stable` name the Project's other Targets, the working
 * Target's Tools are published as `<tool>-dev`, and the dashboard's Monitor shows every Target together as `all`. */
export const RESERVED_PREVIEW_NAMES: readonly string[] = [
  "working",
  "stable",
  "dev",
  "all",
];
/** Pure: the spelling two names are compared in. A Mac's disk does not tell case apart, so `alpha` and `ALPHA` would share
 * one env directory and one Tool path: they are one name. */
export function nameKey(name: string): string {
  return name.toLowerCase();
}
/** Pure: why `name` cannot be given to a Project or Preview (`must ...`), or undefined when it can. */
export function nameProblem(name: string): string | undefined {
  if (!name) return "must not be empty";
  if (name.length > MAX_NAME_LENGTH)
    return `${NAME_LENGTH}; it has ${name.length}`;
  if (!NAME_PATTERN.test(name)) return NAME_CHARACTERS;
  return undefined;
}
/** Pure: the reserved name `name` is a spelling of, or undefined. */
export function reservedPreviewName(name: string): string | undefined {
  return RESERVED_PREVIEW_NAMES.find((reserved) => reserved === nameKey(name));
}
/** Pure: the first of `taken` that `name` would collide with, spelled differently, or undefined. The same spelling is
 * the same name, which the caller decides about. */
export function caseVariantOf(
  name: string,
  taken: Iterable<string>,
): string | undefined {
  for (const other of taken)
    if (other !== name && nameKey(other) === nameKey(name)) return other;
  return undefined;
}

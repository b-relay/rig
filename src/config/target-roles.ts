import { isRecord } from "./record";
export { PREVIEW_SELECTOR } from "../domain/target-selector";

/** The three Target roles. `working` and `stable` are also the fixed names of the one Target each role has. */
export const TARGET_ROLES = ["working", "stable", "preview"] as const;
export type TargetRole = (typeof TARGET_ROLES)[number];
/** The suffix the working Target's Tools are published under, `<tool>-dev`: "working" is too long to type every time. */
export const WORKING_TOOL_SUFFIX = "dev";
/** Whether a role is on: its key under targets is true or a settings map. False, a missing key, or no targets key at all is
 * off. */
export function targetOn(
  config: { targets?: Readonly<Partial<Record<TargetRole, unknown>>> },
  role: TargetRole,
): boolean {
  const value = config.targets?.[role];
  return value === true || isRecord(value);
}

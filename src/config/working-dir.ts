import { join, normalize } from "node:path";
import type { PlanComponent, TargetPlan } from "./types";

/** Pure: a validated working_dir as a plan records it: normalized and relative to the workspace, or undefined for the
 * workspace root itself, so a plan whose Service runs at the root is the plan recorded before working_dir existed. */
export function planWorkingDir(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const path = normalize(value).replace(/\/+$/, "");
  return path === "." || path === "" ? undefined : path;
}

/** Pure: the absolute directory a Component's commands run in: its working_dir inside the plan's workspace, or the
 * workspace root. A plan recorded before working_dir existed has none and runs at the root. */
export function componentDirectory(
  plan: Pick<TargetPlan, "workspacePath">,
  component: PlanComponent | undefined,
): string {
  return component?.kind === "managed" && component.workingDir !== undefined
    ? join(plan.workspacePath, component.workingDir)
    : plan.workspacePath;
}

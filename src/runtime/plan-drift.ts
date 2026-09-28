import type { ProjectConfig, TargetPlan } from "../config/types";
import { targetNames } from "../config/schema";
import type { TargetRecord } from "../domain/runtime";
import type { ProjectDocuments } from "./contracts";
import { recordedPorts } from "./ports";

/** The plan `config` gives a recorded Target now, resolved with the ports, roots, name and source it recorded, so that it
 * compares field for field with the recorded plan. A renamed Working copy or Stable Target resolves under its new name, which
 * is drift until it is planned again. Throws the planner's ConfigError. */
export function replannedPolicy(
  target: Pick<TargetRecord, "kind" | "name" | "branch" | "commit" | "plan">,
  config: ProjectConfig,
  resolve: ProjectDocuments["resolve"],
): TargetPlan {
  return resolve({
    config,
    target: target.kind,
    workspacePath: target.plan.workspacePath,
    dataRoot: target.plan.dataRoot,
    deploymentName:
      target.kind === "preview"
        ? target.name
        : targetNames(config)[target.kind === "local" ? "working" : "stable"],
    branch: target.branch,
    commit: target.commit,
    assignedPorts: recordedPorts(target.plan.components),
  });
}

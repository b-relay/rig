import type { ProjectConfig, TargetPlan } from "../config/types";
import type { TargetRecord } from "../domain/runtime";
import type { ProjectDocuments } from "./contracts";
import { recordedPorts } from "./ports";

/** The plan `config` gives a recorded Target now, resolved with the ports, roots, name and source it recorded, so that it
 * compares field for field with the recorded plan. The working and stable Targets resolve under their fixed names. Throws the planner's ConfigError. */
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
    deploymentName: target.kind === "preview" ? target.name : target.kind,
    branch: target.branch,
    commit: target.commit,
    assignedPorts: recordedPorts(target.plan.components),
  });
}

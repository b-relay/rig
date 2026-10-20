import type { TargetRecord } from "./runtime";
import {
  deploySelector,
  generatedPreviewName,
  shellWord,
  targetSelector,
} from "./target-selector";

/** The rig commands a hint may tell the user to run, by their path in the CLI's grammar. */
export type RigCommandPath =
  | "up"
  | "down"
  | "restart"
  | "deploy"
  | "run"
  | "logs"
  | "status"
  | "doctor"
  | "config"
  | "activity"
  | "backup list"
  | "backup restore";

type TargetRef = Pick<TargetRecord, "kind" | "name" | "branch">;
/** A Target as rigd records it, which knows its Project. */
export type RecordedTarget = TargetRef & { plan: { project: string } };
/** What a printed command acts on. A recorded `target` names its own Project unless `project` says otherwise, since rigd's
 * hints are read from anywhere (a terminal in another directory, Activity, the dashboard). Any other selection states
 * its Project, even as undefined: a command the user typed is retyped with --project only when they typed it. */
export type CommandSelection = {
  job?: string;
  /** A backup id, after the job, for rig backup restore. */
  backup?: string;
  /** The Branch a stable deploy takes after its Target. */
  branch?: string;
  service?: string;
} & (
  | { target: RecordedTarget; project?: string }
  | { target?: TargetRef; project: string | undefined }
);

/** The Target `command` selected, by the `name` rigd answered with when it did: a Preview selected by its Branch is
 * printed with that Branch, and one selected by --deployment with its name. */
export function selectedTarget(
  command: {
    target?: string | undefined;
    branch?: string | undefined;
    deployment?: string | undefined;
  },
  name?: string,
): Pick<TargetRecord, "kind" | "name" | "branch"> {
  if (command.target !== "preview") {
    const kind = command.target === "stable" ? "stable" : "working";
    return { kind, name: name ?? kind };
  }
  const { branch, deployment } = command;
  return {
    kind: "preview",
    name:
      name ??
      deployment ??
      (branch === undefined ? "" : generatedPreviewName(branch)),
    ...(branch === undefined ? {} : { branch }),
  };
}

/** A rig command for a hint to print, in the CLI's grammar, with every word the shell would read quoted: the command,
 * the job and backup it takes first, the Target (as `rig deploy` deploys it again, for a deploy) and a stable deploy's
 * Branch, then --service, --project and `flags`. So `rigCommand("run", { job: "import", target })` for a recorded
 * Preview of Project shop is `rig run import preview feature/x --project shop`. */
export function rigCommand(
  path: RigCommandPath,
  selection: CommandSelection,
  ...flags: string[]
): string {
  const { target, job, backup, branch, service } = selection;
  const project =
    selection.project ??
    (target !== undefined && "plan" in target
      ? target.plan.project
      : undefined);
  return [
    "rig",
    path,
    ...(job === undefined ? [] : [shellWord(job)]),
    ...(backup === undefined ? [] : [shellWord(backup)]),
    ...(target === undefined
      ? []
      : [path === "deploy" ? deploySelector(target) : targetSelector(target)]),
    ...(branch === undefined ? [] : [shellWord(branch)]),
    ...(service === undefined ? [] : ["--service", shellWord(service)]),
    ...(project === undefined ? [] : ["--project", shellWord(project)]),
    ...flags,
  ].join(" ");
}

import type { ProjectConfig } from "../config/types";
import { PREVIEW_SELECTOR } from "../config/schema";
import type { TargetReport } from "../domain/project-status";
import { RigError } from "../domain/errors";
import { rigCommand, selectedTarget } from "../domain/rig-command";
import type { RuntimeCommand } from "../daemon/protocol";
import type { TargetRecord } from "../domain/runtime";
import { assertDeploymentRecovered } from "./deploy";
import { assertTargetOn } from "./targets";

/* What can be done to a Target as it stands: the checks a command makes before it acts, which status also reports so a
 * caller can say why without trying. */

type Refusals = NonNullable<TargetReport["refusals"]>;
/** A refusal as a report carries it: what the command would answer. */
export const refusalOf = (error: RigError) => ({
  code: error.code,
  message: error.message,
  hint: error.hint,
});
/** What `check` refuses, or nothing when it passes. */
function refused(check: () => void): ReturnType<typeof refusalOf> | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    if (error instanceof RigError) return refusalOf(error);
    throw error;
  }
}
/** Only down and destroy act on a Preview whose destruction did not finish, and logs read it. */
export function assertNotDestroying(
  target: Pick<
    TargetRecord,
    "destructionPending" | "kind" | "name" | "branch"
  > & {
    plan: { project: string };
  },
): void {
  if (target.destructionPending)
    throw new RigError(
      "DESTROY_PENDING",
      "Preview destruction is incomplete.",
      `Run ${rigCommand("down", { target }, "--destroy")} to finish it.`,
    );
}
/** Only down settles an unresolved deployment transition. */
export function assertTransitionSettled(target: TargetRecord): void {
  if (target.recovery)
    throw new RigError(
      "DEPLOY_RECOVERY",
      "This Target has an unresolved deployment transition.",
      `Run ${rigCommand("down", { target })} to stop both recorded plans first.`,
    );
}
/** A Target runs a job only deployed completely, meant to run and in no transition. */
export function assertJobsCanRun(target: TargetRecord): void {
  assertTransitionSettled(target);
  // A stopped Target runs no job: rigd's next start would stop the run again as one of a Target meant to be stopped.
  if (target.desired !== "running")
    throw new RigError(
      "JOB_UNAVAILABLE",
      `${target.name} is stopped, so it runs no jobs.`,
      `Run ${rigCommand("up", { target })} first.`,
    );
  if (target.deploymentIncomplete)
    throw new RigError(
      "JOB_UNAVAILABLE",
      `${target.name}'s last deploy did not complete, so its checkout may not be ready to run a job.`,
      `Run ${rigCommand("up", { target })} to finish it, or deploy again.`,
    );
}
/** A command that needs a recorded Target, of one nothing has recorded. Names the Preview by the Branch or deployment the
 * user typed; the hashed slug stays internal. The hint makes the very Target the command selected: a deploy of the stable
 * Target or the Preview, or rig up for the working Target. */
export function missingTarget(
  command: Pick<RuntimeCommand, "target" | "deployment" | "branch">,
  name: string,
  project: string,
): RigError {
  const label =
    command.target === PREVIEW_SELECTOR
      ? `Preview '${command.deployment ?? command.branch ?? name}'`
      : `Target '${name}'`;
  const target = selectedTarget(command, name);
  return new RigError(
    "TARGET_MISSING",
    `${label} has no recorded deployment.`,
    target.kind === "working"
      ? `Start it with ${rigCommand("up", { project, target })}.`
      : `Deploy it first: ${rigCommand("deploy", { project, target })}.`,
  );
}
/** Pure: what rigd refuses of a recorded Target now, by the checks each command makes in the same order. `config` is
 * undefined when rig.yaml cannot be read, which leaves the Target to its record as a command does. A transition whose
 * Operation still runs is no refusal: a command waits its turn behind it and is decided then. */
export function targetRefusals(
  target: TargetRecord,
  config: Pick<ProjectConfig, "targets"> | undefined,
  live: boolean,
): Refusals {
  const admitted = () => {
    if (config) assertTargetOn(config, target.kind);
    assertNotDestroying(target);
  };
  const settled = (check: (target: TargetRecord) => void) => () => {
    admitted();
    if (!live) check(target);
  };
  const checks = {
    up: settled(assertTransitionSettled),
    restart: settled(assertTransitionSettled),
    deploy: settled(assertDeploymentRecovered),
    run: settled(assertJobsCanRun),
    restore: settled(assertJobsCanRun),
  };
  return Object.fromEntries(
    Object.entries(checks).flatMap(([action, check]) => {
      const refusal = refused(check);
      return refusal ? [[action, refusal]] : [];
    }),
  );
}
/** Pure: what rigd refuses of a working or stable Target rig.yaml turns on and nothing has recorded yet. A deploy, or for
 * the working Target a start, is what makes it. */
export function unrecordedRefusals(
  role: "working" | "stable",
  project: string,
): Refusals {
  const missing = refusalOf(missingTarget({ target: role }, role, project));
  return {
    ...(role === "stable" ? { up: missing } : {}),
    restart: missing,
    run: missing,
    restore: missing,
  };
}
/** A deploy names the stable Target or a Preview; the working Target runs the checkout and is never deployed. */
export function deployTargetError(project: string): RigError {
  return new RigError(
    "DEPLOY_TARGET",
    "Deploy needs the stable Target or a Preview.",
    `Use ${rigCommand("up", { project, target: { kind: "working", name: "working" } })} for the working Target.`,
  );
}

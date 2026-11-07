import type { ManagedComponent } from "../config/types";
import { DEFAULT_RESTART_POLICY } from "../config/plan-defaults";
import type { ProcessObservation } from "../providers/contracts";
import type { ServiceActivity } from "./activity";
import { diagnosticErrorCode, recoveredByDownFirst } from "./errors";
import { hostRestartText } from "./host-session";
import type { ComponentReport } from "./project-status";
import {
  DEFAULT_SUPERVISION_SCOPE,
  RESTART_BUDGETS,
  RESTART_LIMIT,
  cleanExit,
  observedOutcome,
  restartBudget,
  type RestartBudget,
  type SupervisionScope,
} from "./restart-policy";
import { rigCommand, type RecordedTarget } from "./rig-command";
import {
  currentRun,
  type ServiceOutcome,
  type ServiceRun,
  type TargetRecord,
} from "./runtime";

/** What status and Activity say about supervising a Service, from the outcomes and decisions of `restart-policy`. */

/** What status says about a Service whose process is stopped, from the record and the observation alone; it writes nothing,
 * so an exit no pass has recorded yet reads the same as it will once one has. */
export function stoppedStanding(
  target: Pick<
    TargetRecord,
    "services" | "plan" | "desired" | "kind" | "name" | "branch"
  >,
  component: ManagedComponent,
  observation: ProcessObservation,
  scope: SupervisionScope = DEFAULT_SUPERVISION_SCOPE,
): Pick<ComponentReport, "state" | "exit" | "exitCode" | "signal" | "reason"> {
  const run = currentRun(target, component.name);
  if (target.desired !== "running" || run?.intent === "stopped")
    return {
      state: "stopped",
      ...(run ? { exit: "requested" } : {}),
      // Still a requested stop, but one the operator should hear needed SIGKILL: the grace may be too short.
      ...(run?.stopKilled
        ? {
            signal: "SIGKILL",
            reason:
              run.stopKilled === "timeout"
                ? "Stopped after timeout (SIGKILL): it did not exit within its stop_timeout."
                : "Killed by --kill (SIGKILL) before its stop_timeout ended.",
          }
        : {}),
    };
  const outcome = run?.outcome ?? observedOutcome(run, observation, "");
  const again = `Run ${rigCommand("up", { target })} to start it again.`;
  if (outcome.kind === "unknown" && outcome.hostRestart)
    return {
      state: "stopped",
      exit: "unknown",
      reason: `It stopped when ${hostRestartText(outcome.hostRestart)}. Only stable Targets are started again after that; the working Target and Previews stay stopped. ${again}`,
    };
  const policy = component.restart ?? DEFAULT_RESTART_POLICY;
  const budget = restartBudget(policy, outcome, scope);
  const pending = budget !== undefined && !run?.exhausted;
  const next = run?.waitingFor
    ? waitingText(run.waitingFor)
    : "an automatic restart is scheduled";
  if (outcome.kind === "unknown") {
    const ended =
      "The process is not running and nothing recorded how it ended";
    return {
      state: pending ? "starting" : "failed",
      exit: "unknown",
      reason: pending
        ? `${ended}; under restart: always it is started again once it is verified gone and its ports are free (${next}).`
        : run?.exhausted
          ? `${ended}, and it ${exhaustedText("unknown-exit")}, so it stays stopped. ${again}`
          : `${ended}, so it was not restarted. ${again}`,
    };
  }
  const ended =
    outcome.kind === "exited"
      ? `The process ${describeExit(outcome)}`
      : `The last start failed (${outcome.errorCode})`;
  return {
    state: pending ? "starting" : cleanExit(outcome) ? "stopped" : "failed",
    exit: cleanExit(outcome) ? "clean" : "failed",
    ...(outcome.kind === "exited" && outcome.exitCode !== undefined
      ? { exitCode: outcome.exitCode }
      : {}),
    ...(outcome.kind === "exited" && outcome.signal !== undefined
      ? { signal: outcome.signal }
      : {}),
    reason: pending
      ? `${ended}; ${next}.`
      : run?.exhausted
        ? `${ended} after ${RESTART_LIMIT} automatic restarts within ${RESTART_BUDGETS["known-exit"].window}, so it stays stopped. ${again}`
        : outcome.kind === "start-failed"
          ? `${ended}. ${recoveredByDownFirst(outcome.errorCode) ? `Run ${rigCommand("down", { target })}, then ${rigCommand("up", { target })} to start it again.` : again}`
          : `${ended} and its restart policy is ${policy}, so it stays stopped. ${again}`,
  };
}

/** What status adds about a running Service: that it was started again automatically after an unknown exit, or by rigd
 * after a Host restart, while the process running is the one that start made. */
export function runningNote(
  target: Pick<TargetRecord, "services" | "plan">,
  component: ManagedComponent,
  observation: ProcessObservation,
): string | undefined {
  const run = currentRun(target, component.name);
  if (
    observation.incarnation === undefined ||
    observation.incarnation !== run?.incarnation
  )
    return undefined;
  if (run.restartedAfterUnknown)
    return "Started again automatically after its previous process ended with nothing recorded about how (unknown exit, restarted).";
  if (run.startedAfterHostRestart)
    return `Started again by rigd after ${hostRestartText(run.startedAfterHostRestart)} (${run.startedAfterHostRestart === "reboot" ? "restarted after reboot" : "restarted after login"}).`;
  return undefined;
}

/** Activity for an exit a pass recorded; `budget` is the one it is started again from, if any. */
export function exitActivity(
  service: string,
  outcome: ServiceOutcome,
  budget: RestartBudget | undefined,
): ServiceActivity {
  if (outcome.kind !== "exited")
    return {
      action: "exit",
      outcome: "failed",
      message: budget
        ? `${service} is not running and nothing recorded how it ended; under restart: always it is started again once it is verified gone and its ports are free.`
        : `${service} is not running and nothing recorded how it ended, so it was not started again.`,
    };
  return {
    action: cleanExit(outcome) ? "exit" : "crash",
    outcome: cleanExit(outcome) ? "stopped" : "failed",
    message: `${service} ${describeExit(outcome)}.`,
  };
}

/** Activity for a Service whose `budget` is used up. */
export function exhaustedActivity(
  service: string,
  budget: RestartBudget,
  target: RecordedTarget,
): ServiceActivity {
  return {
    action: "restart",
    outcome: "failed",
    message: `${service} ${exhaustedText(budget)} and stays stopped. Run ${rigCommand("restart", { target })} once the cause is fixed.`,
  };
}

/** Activity for an automatic attempt that failed with `error`. */
export function failedAttemptActivity(
  service: string,
  error: unknown,
): ServiceActivity {
  return {
    action: "restart",
    outcome: "failed",
    message: `${service} could not be started again automatically (${diagnosticErrorCode(error)}).`,
  };
}

/** Activity for a due attempt held back, spending nothing. */
export function waitingActivity(
  service: string,
  waitingFor: NonNullable<ServiceRun["waitingFor"]>,
): ServiceActivity {
  return {
    action: "restart",
    outcome: "unchanged",
    message: `${service} is not started again yet: ${waitingText(waitingFor)}. Waiting spends none of its automatic restarts.`,
  };
}

/** Activity for an automatic attempt from `budget` that started the Service, the `attempt`th the window holds. */
export function restartedActivity(
  service: string,
  budget: RestartBudget,
  attempt: number,
): ServiceActivity {
  const rule = RESTART_BUDGETS[budget];
  return {
    action: "restart",
    outcome: "started",
    message:
      budget === "known-exit"
        ? `${service} was started again automatically (attempt ${attempt} of ${rule.limit} within ${rule.window}).`
        : `${service} ended with nothing recorded about how and was started again automatically (unknown exit, restarted: attempt ${attempt} of ${rule.limit} within ${rule.window}).`,
  };
}

/** "used its 5 automatic restarts within 60 s", "ended with nothing recorded after its 3 automatic restarts within 10 min". */
function exhaustedText(budget: RestartBudget): string {
  const rule = RESTART_BUDGETS[budget];
  return budget === "known-exit"
    ? `used its ${rule.limit} automatic restarts within ${rule.window}`
    : `ended with nothing recorded about how after its ${rule.limit} automatic restarts for unknown exits within ${rule.window}`;
}

function waitingText(
  waitingFor: NonNullable<ServiceRun["waitingFor"]>,
): string {
  if ("service" in waitingFor)
    return `waiting for ${waitingFor.service}, which it depends on, to be running`;
  const [first, ...rest] = waitingFor.ports;
  return rest.length
    ? `waiting for ports ${waitingFor.ports.join(", ")}, which still accept connections, to be free`
    : `waiting for port ${first}, which still accepts connections, to be free`;
}

/** Who recorded an end the application's own record does not describe. `launchd` appears only in outcomes recorded by Rig
 * versions that offered launchd supervision. */
const WITNESSES = {
  launchd: "from launchd's record of its job",
  rigd: "from rigd's record of its capture wrapper",
} as const;

/** "exited with code 3", "was ended by SIGKILL", "was ended by SIGTERM (from rigd's record of its capture wrapper)". */
export function describeExit(
  outcome: Extract<ServiceOutcome, { kind: "exited" }>,
): string {
  const ended =
    outcome.signal === undefined
      ? `exited with code ${outcome.exitCode}`
      : `was ended by ${outcome.signal}`;
  return outcome.recordedBy === undefined
    ? ended
    : `${ended} (${WITNESSES[outcome.recordedBy]})`;
}

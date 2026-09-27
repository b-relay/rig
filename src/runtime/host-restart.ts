import { recordActivity } from "../domain/activity";
import { diagnosticErrorCode } from "../domain/errors";
import {
  hostRestartBetween,
  hostRestartText,
  sessionToRecord,
  type HostRestart,
  type HostSession,
} from "../domain/host-session";
import type { RuntimeState, TargetRecord } from "../domain/runtime";
import type { RuntimeDependencies } from "./contracts";
import { activationJournal, intendRunning } from "./supervision";

type Deps = Pick<RuntimeDependencies, "store" | "now" | "id">;

/** What the daemon's first pass found about the Host: the restart since the session rigd last recorded, if any, and the
 * session to record once it has acted on it. */
export interface HostSessionFinding {
  restart?: HostRestart;
  session: HostSession;
}

/** Compares the session read now with the one `state` records. */
export function findHostRestart(
  state: Pick<RuntimeState, "host">,
  current: HostSession,
): HostSessionFinding {
  const restart = hostRestartBetween(state.host, current);
  return {
    ...(restart ? { restart } : {}),
    session: sessionToRecord(state.host, current),
  };
}

/** Records the one Activity entry for a detected Host restart. */
export async function recordHostRestart(
  finding: HostSessionFinding & { restart: HostRestart },
  deps: Deps,
): Promise<void> {
  const booted =
    finding.restart === "reboot" && finding.session.bootedAt
      ? ` (booted ${finding.session.bootedAt})`
      : "";
  const what = hostRestartText(finding.restart);
  await deps.store.update((state) =>
    recordActivity(state, {
      id: deps.id(),
      action: "host-restart",
      outcome: "stopped",
      occurredAt: deps.now(),
      message: `${what[0]!.toUpperCase()}${what.slice(1)}${booted}, which stopped every Service. rigd starts the Stable Targets meant to run again; the Working copy and Previews stay stopped until rig up.`,
    }),
  );
}

/** Records `session` as the one rigd has acted on, so its next start compares against it. */
export async function saveHostSession(
  session: HostSession,
  deps: Deps,
): Promise<void> {
  await deps.store.update((state) => {
    state.host = { ...session, seenAt: deps.now() };
  });
}

/** Starts a Stable Target meant to run again after `restart`, the way an explicit `rig up` does: every stopped Service in
 * dependency order, whatever its restart policy, with full automatic-restart budgets. A Service still running is adopted.
 * Records one Activity entry for the Target. A start that fails leaves the Services it began recorded as not started, and
 * the Target meant to run, which status reports as failed until `rig up`; the failure is recorded, never raised. */
export async function startAfterHostRestart(
  target: TargetRecord,
  restart: HostRestart,
  deps: Pick<
    RuntimeDependencies,
    "store" | "now" | "id" | "lifecycle" | "diagnostic"
  >,
): Promise<void> {
  const journal = activationJournal(target, "explicit", deps, {
    afterHostRestart: restart,
  });
  const after = hostRestartText(restart);
  let outcome: "started" | "unchanged";
  try {
    outcome = (await deps.lifecycle.up(target, undefined, journal)).outcome;
  } catch (error) {
    await journal.failed(error).catch(() => {});
    const errorCode = diagnosticErrorCode(error);
    await deps
      .diagnostic({
        operationId: deps.id(),
        action: "up",
        outcome: "failed",
        target: target.name,
        errorCode,
      })
      .catch(() => {});
    await deps.store.update((state) =>
      recordActivity(state, {
        id: deps.id(),
        projectId: target.projectId,
        project: state.projects.find((p) => p.id === target.projectId)?.name,
        target: target.name,
        action: "up",
        outcome: "failed",
        occurredAt: deps.now(),
        message: `${target.name} could not be started again after ${after} (${errorCode}). Run rig up ${target.name} once the cause is fixed.`,
      }),
    );
    return;
  }
  intendRunning(target);
  // As after an explicit up: the recorded plan is installed, routed and started under its own committed checkpoint.
  delete target.deploymentIncomplete;
  target.desired = "running";
  target.updatedAt = deps.now();
  await deps.store.update((state) => {
    const index = state.targets.findIndex((t) => t.id === target.id);
    if (index !== -1) state.targets[index] = target;
    recordActivity(state, {
      id: deps.id(),
      projectId: target.projectId,
      project: state.projects.find((p) => p.id === target.projectId)?.name,
      target: target.name,
      action: "up",
      outcome,
      occurredAt: deps.now(),
      message:
        outcome === "started"
          ? `Started again after ${after} (restarted after ${restart === "reboot" ? "reboot" : "login"}).`
          : `Found already running after ${after}.`,
    });
  });
}

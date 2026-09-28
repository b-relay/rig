import { recordActivity } from "../domain/activity";
import { diagnosticErrorCode, recoveredByDownFirst } from "../domain/errors";
import {
  hostRestartBetween,
  hostRestartText,
  identified,
  mayReplace,
  type HostRestart,
  type HostSession,
} from "../domain/host-session";
import type { RuntimeState, TargetRecord } from "../domain/runtime";
import type { RuntimeDependencies } from "./contracts";
import {
  activationJournal,
  intendRunning,
  recordFailedStart,
} from "./supervision";

type Deps = Pick<RuntimeDependencies, "store" | "now" | "id">;

/** What the daemon's first pass found about the Host: the restart since the session rigd last recorded, if any, whether
 * an earlier daemon already recorded that restart in Activity, the session read now, and whether that session is to be
 * recorded once the pass has acted on it. */
export interface HostSessionFinding {
  restart?: HostRestart;
  announced: boolean;
  /** The Stable Targets an earlier daemon already started again, or whose start failed, for this same restart. */
  settled: ReadonlySet<string>;
  /** How the pending restart is identified in state: as an earlier daemon found it, or as found now. */
  mark?: RestartMark;
  session: HostSession;
  record: boolean;
}

/** Compares the session read now with what rigd knows of it. Without a pending restart that is the recorded session. A
 * restart an earlier daemon found but did not finish acting on is pending; what rigd knew when it found it is the recorded
 * session carried across that restart (see `across`). The pending restart stays the one to act on (its kind, its settled
 * Targets, announced or not) unless the read now shows a change since; a change is a new restart of its own. The session
 * recorded once a restart is acted on keeps, where the read now missed a field, what is still known of it. */
export function findHostRestart(
  state: Pick<RuntimeState, "host">,
  current: HostSession,
): HostSessionFinding {
  const pending = state.host?.restart;
  const recorded = known(state.host);
  const baseline = pending
    ? across(recorded, pending.kind, known(pending))
    : recorded;
  const since = hostRestartBetween(pending ? baseline : state.host, current);
  if (pending && since === undefined) {
    const session = across(baseline, undefined, current);
    return {
      restart: pending.kind,
      announced: pending.unannounced !== true,
      settled: new Set(pending.settled ?? []),
      mark: { kind: pending.kind, ...known(pending) },
      session,
      record: identified(session),
    };
  }
  if (since) {
    const session = across(baseline, since, current);
    return {
      restart: since,
      announced: false,
      settled: new Set(),
      mark: { kind: since, ...known(session) },
      session,
      record: identified(session),
    };
  }
  return {
    announced: false,
    settled: new Set(),
    session: current,
    record: mayReplace(state.host, current),
  };
}

/** The boot and login of `session` that were read. */
function known(
  session: Pick<HostSession, "boot" | "login"> | undefined,
): Pick<HostSession, "boot" | "login"> {
  return {
    ...(session?.boot === undefined ? {} : { boot: session.boot }),
    ...(session?.login === undefined ? {} : { login: session.login }),
  };
}

/** What is known of the session after `restart`, from what was known `before` it and what was read `after` it. A reboot
 * ends every login session, so nothing from before it is kept; a new login keeps the boot; no restart keeps both. A field
 * read after always wins. */
function across(
  before: Pick<HostSession, "boot" | "login">,
  restart: HostRestart | undefined,
  after: HostSession,
): HostSession {
  const kept =
    restart === "reboot"
      ? {}
      : restart === "login"
        ? before.boot === undefined
          ? {}
          : { boot: before.boot }
        : before;
  return { ...kept, ...definedFields(after) };
}

/** The fields of `session` that were read. */
function definedFields(session: HostSession): HostSession {
  return Object.fromEntries(
    Object.entries(session).filter(([, value]) => value !== undefined),
  ) as HostSession;
}

/** Records the one Activity entry for a detected Host restart, and, in the same write, that rigd is acting on it, with
 * the Targets already `settled` for it when the entry is written late (together with any a Target's own write noted). */
export async function recordHostRestart(
  finding: HostSessionFinding & { restart: HostRestart },
  deps: Deps,
  settled: readonly string[] = [],
): Promise<void> {
  const booted =
    finding.restart === "reboot" && finding.session.bootedAt
      ? ` (booted ${finding.session.bootedAt})`
      : "";
  const what = hostRestartText(finding.restart);
  const mark = restartMark(finding);
  await deps.store.update((state) => {
    recordActivity(state, {
      id: deps.id(),
      action: "host-restart",
      outcome: "stopped",
      occurredAt: deps.now(),
      message: `${what[0]!.toUpperCase()}${what.slice(1)}${booted}, which stops the Services Rig runs. rigd starts the Stable Targets meant to run again; the Working copy's and Previews' Services that stopped stay stopped until rig up.`,
    });
    if (state.host)
      state.host.restart = {
        ...mark,
        settled: [
          ...new Set([
            ...finding.settled,
            // A Stable Target's own write may have noted it in this restart already.
            ...(sameMark(state.host.restart, mark)
              ? (state.host.restart?.settled ?? [])
              : []),
            ...settled,
          ]),
        ],
      };
  });
}

/** The pending restart a Stable Target's start is noted in: its kind and the boot and login it was found with. */
export type RestartMark = { kind: HostRestart } & Pick<
  HostSession,
  "boot" | "login"
>;

/** The mark of the restart `finding` found. */
export function restartMark(
  finding: HostSessionFinding & { restart: HostRestart },
): RestartMark {
  return finding.mark ?? { kind: finding.restart, ...known(finding.session) };
}

/** Whether the pending restart in state is the one `mark` identifies. */
function sameMark(
  pending: RestartMark | undefined,
  mark: RestartMark,
): boolean {
  return (
    pending !== undefined &&
    pending.kind === mark.kind &&
    pending.boot === mark.boot &&
    pending.login === mark.login
  );
}

/** Notes in the pending restart that `targetId`, a Stable Target, was started again or failed to start for it. When the
 * restart's own entry could not be written, the note starts the pending restart, marked unannounced, so a daemon that
 * finds it again neither starts the Target again nor forgets to announce it. */
function markSettled(
  state: RuntimeState,
  targetId: string,
  mark: RestartMark,
): void {
  if (!state.host) return;
  const pending = sameMark(state.host.restart, mark)
    ? state.host.restart!
    : { ...mark, settled: [], unannounced: true as const };
  if (!pending.settled?.includes(targetId))
    pending.settled = [...(pending.settled ?? []), targetId];
  state.host.restart = pending;
}

/** Records `session` as the one rigd has acted on, so its next start compares against it; it replaces any pending restart. */
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
 * Records one Activity entry for the Target. A start that fails leaves every Service not running recorded as not started
 * (never retried automatically) and the Target meant to run, which status reports as failed until `rig up`; the failure is
 * recorded, never raised. Returns whether the Target is settled: false when a Service could not be recorded as not
 * started, so the restart is acted on again. */
export async function startAfterHostRestart(
  target: TargetRecord,
  mark: RestartMark,
  deps: Pick<
    RuntimeDependencies,
    | "store"
    | "now"
    | "id"
    | "lifecycle"
    | "diagnostic"
    | "observations"
    | "observationBudgetMs"
    | "observationDeadline"
  >,
): Promise<boolean> {
  const restart = mark.kind;
  const journal = activationJournal(target, "explicit", deps, {
    afterHostRestart: restart,
  });
  const after = hostRestartText(restart);
  let outcome: "started" | "unchanged";
  try {
    outcome = (await deps.lifecycle.up(target, undefined, journal)).outcome;
  } catch (error) {
    await journal.failed(error).catch(() => {});
    const settled = await recordFailedStart(target, error, deps);
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
    await deps.store.update((state) => {
      if (settled) markSettled(state, target.id, mark);
      recordActivity(state, {
        id: deps.id(),
        projectId: target.projectId,
        project: state.projects.find((p) => p.id === target.projectId)?.name,
        target: target.name,
        action: "up",
        outcome: "failed",
        occurredAt: deps.now(),
        message: `${target.name} could not be started again after ${after} (${errorCode}). ${
          recoveredByDownFirst(errorCode)
            ? `Run rig down ${target.name}, then rig up ${target.name}.`
            : `Run rig up ${target.name} once the cause is fixed.`
        }`,
      });
    });
    return settled;
  }
  intendRunning(target);
  // As after an explicit up: the recorded plan is installed, routed and started under its own committed checkpoint.
  delete target.deploymentIncomplete;
  target.desired = "running";
  target.updatedAt = deps.now();
  await deps.store.update((state) => {
    const index = state.targets.findIndex((t) => t.id === target.id);
    if (index !== -1) state.targets[index] = target;
    markSettled(state, target.id, mark);
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
  return true;
}

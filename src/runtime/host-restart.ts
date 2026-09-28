import { recordActivity } from "../domain/activity";
import { diagnosticErrorCode, recoveredByDownFirst } from "../domain/errors";
import { isStopDetached } from "../domain/stop-budget";
import {
  hostRestartBetween,
  hostRestartText,
  identified,
  mayReplace,
  type HostRestart,
  type HostSession,
} from "../domain/host-session";
import type {
  OperationRecord,
  RuntimeState,
  TargetRecord,
} from "../domain/runtime";
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
  /** The Targets an earlier daemon already settled for this same restart: Stable Targets started again (or whose start
   * failed), and Working copies and Previews whose stopped Services it recorded as stopped by the restart. */
  settled: ReadonlySet<string>;
  /** How the pending restart is identified in state: as an earlier daemon found it, or as found now. */
  mark?: RestartMark;
  session: HostSession;
  record: boolean;
}

/** Compares the session read now with what rigd knows of it. Without a pending restart that is the recorded session. A
 * restart an earlier daemon found but did not finish acting on is pending; what rigd knew when it found it is the recorded
 * session carried across that restart (see `across`). The pending restart stays the one to act on (its kind, its settled
 * Targets, announced or not) unless the read now shows a change since; a change is a new restart of its own, whose mark
 * carries the pending restart forward when its Activity entry was never written, so it is announced still. A restart
 * that left nothing in state (no write of the daemon that found it succeeded) cannot be told apart from a later one: after
 * another reboot the Host shows only the new boot, so the two are one restart here. The session recorded once a restart
 * is acted on keeps, where the read now missed a field, what is still known of it. */
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
  // Earlier restarts no daemon could announce; only an unannounced pending restart carries any.
  const earlier = pending?.unannounced ? (pending.unannouncedBefore ?? []) : [];
  if (pending && since === undefined) {
    const session = across(baseline, undefined, current);
    return {
      restart: pending.kind,
      announced: pending.unannounced !== true,
      settled: new Set(pending.settled ?? []),
      mark: withEarlier(identity(pending), earlier),
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
      // A pending restart not announced yet is announced with this one, ahead of it.
      mark: withEarlier(
        { kind: since, ...known(session) },
        pending?.unannounced ? [...earlier, identity(pending)] : [],
      ),
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

/** How a restart recorded in state is identified: its kind and the boot and login it was found with. */
function identity(restart: RestartIdentity): RestartIdentity {
  return { kind: restart.kind, ...known(restart) };
}

/** `mark`, carrying the `earlier` restarts still to be announced when there are any. */
function withEarlier(
  mark: RestartIdentity,
  earlier: readonly RestartIdentity[],
): RestartMark {
  return earlier.length
    ? { ...mark, unannouncedBefore: earlier.map(identity) }
    : mark;
}

/** The fields of `session` that were read. */
function definedFields(session: HostSession): HostSession {
  return Object.fromEntries(
    Object.entries(session).filter(([, value]) => value !== undefined),
  ) as HostSession;
}

/** Records the one Activity entry for a detected Host restart, and, in the same write, that rigd is acting on it, with
 * the Targets already `settled` for it when the entry is written late (together with any a Target's own write noted).
 * Earlier restarts whose entries no daemon could write (the mark's `unannouncedBefore`) get theirs first, oldest first. */
export async function recordHostRestart(
  finding: HostSessionFinding & { restart: HostRestart },
  deps: Deps,
  settled: readonly string[] = [],
): Promise<void> {
  const { unannouncedBefore = [], ...mark } = restartMark(finding);
  const bootedAt =
    finding.restart === "reboot" ? finding.session.bootedAt : undefined;
  await deps.store.update((state) => {
    // A write reported failed may still have landed; a restart state already shows announced is not announced again.
    const announced =
      sameMark(state.host?.restart, mark) && !state.host!.restart!.unannounced;
    if (!announced) {
      for (const earlier of unannouncedBefore)
        recordActivity(state, hostRestartEntry(earlier.kind, "late", deps));
      recordActivity(
        state,
        hostRestartEntry(
          finding.restart,
          bootedAt ? { bootedAt } : "found",
          deps,
        ),
      );
    }
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

/** The Activity entry for a Host restart of kind `restart`: one just found (with when the Mac booted, when read), or an
 * earlier one whose entry is written `late`, after a later restart was found. */
function hostRestartEntry(
  restart: HostRestart,
  when: "found" | { bootedAt: string } | "late",
  deps: Pick<Deps, "id" | "now">,
): OperationRecord {
  const what = hostRestartText(restart);
  const booted = typeof when === "object" ? ` (booted ${when.bootedAt})` : "";
  const late =
    when === "late"
      ? " Recorded late: rigd could not write this entry when it found the restart, and the Host restarted again since."
      : "";
  return {
    id: deps.id(),
    action: "host-restart",
    outcome: "stopped",
    occurredAt: deps.now(),
    message: `${what[0]!.toUpperCase()}${what.slice(1)}${booted}, which stops the Services Rig runs. rigd starts the Stable Targets meant to run again; the Working copy's and Previews' Services that stopped stay stopped until rig up.${late}`,
  };
}

/** A Host restart as rigd identifies it: its kind and the boot and login it was found with. */
export type RestartIdentity = { kind: HostRestart } & Pick<
  HostSession,
  "boot" | "login"
>;

/** The pending restart a Stable Target's start is noted in, with the earlier restarts whose Activity entries no daemon has
 * written yet, oldest first. */
export type RestartMark = RestartIdentity & {
  unannouncedBefore?: readonly RestartIdentity[];
};

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

/** Notes in the pending restart that `targetId` is settled for it: a Stable Target started again or failed to start, or
 * a Working copy or Preview whose stopped Services were recorded as stopped by it. When the
 * restart's own entry could not be written, the note starts the pending restart, marked unannounced and carrying the
 * earlier restarts still unannounced, so a daemon that finds it again neither starts the Target again nor forgets to
 * announce any of them. */
function markSettled(
  state: RuntimeState,
  targetId: string,
  mark: RestartMark,
): void {
  if (!state.host) return;
  const { unannouncedBefore, ...found } = mark;
  const pending = sameMark(state.host.restart, mark)
    ? state.host.restart!
    : {
        ...found,
        settled: [],
        unannounced: true as const,
        ...(unannouncedBefore?.length
          ? { unannouncedBefore: [...unannouncedBefore] }
          : {}),
      };
  if (!pending.settled?.includes(targetId))
    pending.settled = [...(pending.settled ?? []), targetId];
  state.host.restart = pending;
}

/** Notes in the pending restart that `targetId`, a Working copy or Preview, has had its stopped Services recorded as
 * stopped by it, so a daemon that finishes the restart later does not record them again: by then an explicit start may
 * have ended the restart's hold on them. */
export async function noteMarkedForHostRestart(
  targetId: string,
  mark: RestartMark,
  deps: Deps,
): Promise<void> {
  await deps.store.update((state) => markSettled(state, targetId, mark));
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

type StartDeps = Pick<
  RuntimeDependencies,
  | "store"
  | "now"
  | "id"
  | "lifecycle"
  | "diagnostic"
  | "observations"
  | "observationBudgetMs"
  | "observationDeadline"
>;

/** How a Stable Target's start after a Host restart left it for that restart. */
export type HostRestartStart =
  /** Started, found running, or its failure recorded: the restart is done for it. */
  | { readonly outcome: "settled" }
  /** rigd's shutdown detached the start: the next daemon starts it again. */
  | { readonly outcome: "pending" }
  /** The start failed with `error`, and the failure could not be saved yet. */
  | { readonly outcome: "unrecorded"; readonly error: unknown };

/** Saves, in one write, that the start of Stable Target `target` after the restart `mark` identifies failed with `error`:
 * each Service not running as not started (see `recordFailedStart`), the Target as settled for the restart, and the start's
 * one Activity entry. All of it is saved or none is, so a later daemon never starts again a Target whose failure it can
 * read, and never finds a failure recorded without its entry. Returns whether it was saved; a failure goes to the
 * diagnostic log. */
export async function recordFailedAfterHostRestart(
  target: TargetRecord,
  error: unknown,
  mark: RestartMark,
  deps: StartDeps,
): Promise<boolean> {
  const errorCode = diagnosticErrorCode(error);
  const after = hostRestartText(mark.kind);
  return await recordFailedStart(target, error, deps, (state) => {
    // A write reported failed may still have landed; a Target already settled for the restart has its entry.
    if (
      sameMark(state.host?.restart, mark) &&
      state.host!.restart!.settled?.includes(target.id)
    )
      return;
    markSettled(state, target.id, mark);
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
}

/** Starts a Stable Target meant to run again after `restart`, the way an explicit `rig up` does: every stopped Service in
 * dependency order, whatever its restart policy, with full automatic-restart budgets. A Service still running is adopted.
 * Records one Activity entry for the Target. A start that fails leaves every Service not running recorded as not started
 * (never retried automatically) and the Target meant to run, which status reports as failed until `rig up`; the failure is
 * recorded, never raised. A start whose clean-up stop rigd's shutdown detached records nothing, as after a crash: the
 * restart stays pending for the Target, and the next daemon starts it again. Resolves `settled` once the Target is settled
 * for the restart; `pending` when the start was detached; `unrecorded` when the start failed and its failure could not be
 * saved, which the caller saves later with `recordFailedAfterHostRestart` before anything else acts on the Target. */
export async function startAfterHostRestart(
  target: TargetRecord,
  mark: RestartMark,
  deps: StartDeps,
): Promise<HostRestartStart> {
  const restart = mark.kind;
  const journal = activationJournal(target, "explicit", deps, {
    afterHostRestart: restart,
  });
  const after = hostRestartText(restart);
  let outcome: "started" | "unchanged";
  try {
    outcome = (await deps.lifecycle.up(target, undefined, journal)).outcome;
  } catch (error) {
    if (isStopDetached(error)) return { outcome: "pending" };
    await journal.failed(error).catch(() => {});
    await deps
      .diagnostic({
        operationId: deps.id(),
        action: "up",
        outcome: "failed",
        target: target.name,
        errorCode: diagnosticErrorCode(error),
      })
      .catch(() => {});
    return (await recordFailedAfterHostRestart(target, error, mark, deps))
      ? { outcome: "settled" }
      : { outcome: "unrecorded", error };
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
  return { outcome: "settled" };
}

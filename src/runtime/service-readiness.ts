import type { ManagedComponent } from "../config/types";
import type { TargetRecord } from "../domain/runtime";
import { targetSelector } from "../domain/target-selector";
import { RigError } from "../domain/errors";
import type { HealthCheck, ProcessObservation } from "../providers/contracts";
import {
  UPSTREAM_HOST,
  routeUpstream,
  takesUpstream,
} from "../domain/route-upstream";
import { declaredPorts } from "./ports";
import { routedPorts } from "./plan-services";
import type { TargetEffects } from "./lifecycle";

// Whether a Service of a start counts as ready: its check, its survival, what it listens on, and whether it still runs as
// the process that was verified. Activation decides when to ask; only this module decides the answer.

export interface ReadinessTiming {
  /** Schedule once after delayMs; never inline. Return an idempotent cancellation.
   * Callbacks and cancellation must not throw. Elapsed callbacks run in deadline order.
   */
  schedule(delayMs: number, fire: () => void): () => void;
  /** How long a component without a health check must stay alive before up counts it as started; default 500 ms. */
  readonly startGraceMs?: number;
}

/** Production scheduling effect owner; lifecycle callers may substitute controlled time. */
export const defaultReadinessTiming: ReadinessTiming = {
  schedule(delayMs, fire) {
    const timer = setTimeout(fire, delayMs);
    return () => clearTimeout(timer);
  },
};
const DEFAULT_START_GRACE_MS = 500;
/** Cadence for health retries and for confirming the supervised process is still alive. */
const OBSERVATION_INTERVAL_MS = 100;

/** The supervised process behind one component; readiness only counts while it is alive. */
export interface SupervisedProcess {
  observe(): Promise<ProcessObservation>;
}
/** Whether the Service has something to be ready on: its own check, or declared ports to connect to. */
export function hasReadiness(component: ManagedComponent): boolean {
  return (
    component.health !== undefined ||
    Object.keys(declaredPorts(component)).length > 0
  );
}
/** One Service is verified within its `readyTimeout`: ready, then listening only locally. Ready is its own check, else a
 * connection to every declared port, else nothing beyond being alive. Readiness passes only while rig's own process is running:
 * a foreign listener on the port never certifies a dead component, and a process that exits fails fast with its exit code.
 * HEALTH_FAILED says how the budget ended: `unanswered` when no check ever answered, `unready` with the last answer otherwise.
 * A rejecting provider fails with its own error at once; LISTENER_NONLOCAL and LISTENER_UNKNOWN are not waited out either.
 * When `failed` rejects, the check ends as its deadline would, with that failure. */
export async function awaitActivation(
  component: ManagedComponent,
  target: TargetRecord,
  effects: Pick<TargetEffects, "health" | "listeners">,
  timing: ReadinessTiming,
  process: SupervisedProcess,
  failed?: Promise<never>,
): Promise<void> {
  const controller = new AbortController();
  let cancelDeadline = () => {};
  let cancelRetry = () => {};
  // Expiry settles independently of provider cooperation, and so does a failure from elsewhere.
  const deadline = new Promise<false>((resolve) => {
    cancelDeadline = timing.schedule(component.readyTimeout * 1000, () => {
      resolve(false);
      controller.abort();
    });
  });
  const expired = failed ? Promise.race([deadline, failed]) : deadline;
  expired.catch(() => controller.abort());
  let lastCheck: string | undefined;
  try {
    while (!controller.signal.aborted) {
      // An observation that never answers is bounded like any other check.
      if (
        (await Promise.race([assertAlive(component, process), expired])) ===
        false
      )
        break;
      const check = await Promise.race([
        hasReadiness(component)
          ? effects.health(component, target, controller.signal)
          : ALIVE,
        expired,
      ]);
      if (controller.signal.aborted || check === false) break;
      const verified = check.ready
        ? await Promise.race([
            ownedListeners(
              component,
              target,
              effects,
              process,
              controller.signal,
            ),
            expired,
          ])
        : check;
      if (controller.signal.aborted || verified === false) break;
      if (verified.ready) return;
      lastCheck = verified.reason;
      await Promise.race([
        new Promise<void>((resolve) => {
          cancelRetry = timing.schedule(OBSERVATION_INTERVAL_MS, resolve);
        }),
        expired,
      ]);
    }
  } finally {
    cancelDeadline();
    cancelRetry();
  }
  throw new RigError(
    "HEALTH_FAILED",
    lastCheck === undefined
      ? `${component.name} did not become ready.`
      : `${component.name} did not become ready (last check: ${lastCheck}).`,
    "Inspect the Target logs and the Service's healthcheck.",
    {
      component: component.name,
      outcome: lastCheck === undefined ? "unanswered" : "unready",
      ...(lastCheck === undefined ? {} : { lastCheck }),
    },
  );
}
/** A Service a start verified, with the process it verified. */
export interface Activated {
  component: ManagedComponent;
  process: SupervisedProcess;
  seen: ProcessObservation;
}
/** A Service a start verified, verified again once a later part of the start is done, as `awaitActivation`: one that ended
 * meanwhile fails PROCESS_EXITED, saying it did so after it was ready, and whether the start was `published`. */
export async function confirmActivated(
  component: ManagedComponent,
  target: TargetRecord,
  effects: Pick<TargetEffects, "health" | "listeners">,
  timing: ReadinessTiming,
  process: SupervisedProcess,
  failed: Promise<never> | undefined,
  published: boolean,
): Promise<void> {
  try {
    await awaitActivation(component, target, effects, timing, process, failed);
  } catch (error) {
    if (!(error instanceof RigError) || error.code !== "PROCESS_EXITED")
      throw error;
    // A failure the guard latched names a Service of its own.
    if (error.details.component !== component.name) throw error;
    throw exitedAfterReady(component, target, error.details ?? {}, published);
  }
}
/** Each of `activated` observed once more: still running as the process it verified (same pid and incarnation), else the
 * start fails PROCESS_EXITED. */
export async function assertStillActive(
  activated: readonly Activated[],
  target: TargetRecord,
  published: boolean,
  failed?: Promise<never>,
): Promise<void> {
  for (const { component, process, seen } of activated) {
    // An observation that never answers holds off no failure from elsewhere.
    const now = await (failed
      ? Promise.race([process.observe(), failed])
      : process.observe());
    if (
      now.state === "running" &&
      now.pid === seen.pid &&
      now.incarnation === seen.incarnation
    )
      continue;
    throw exitedAfterReady(
      component,
      target,
      exitDetails(component.name, now),
      published,
    );
  }
}
/** What a failure says of how `service`'s process ended, as `seen`. */
export function exitDetails(
  service: string,
  seen: ProcessObservation,
): Record<string, unknown> {
  return {
    component: service,
    ...(seen.exitCode === undefined ? {} : { exitCode: seen.exitCode }),
    ...(seen.signal === undefined ? {} : { signal: seen.signal }),
  };
}
/** PROCESS_EXITED for a Service that was ready, then ended before its start finished; its hint says that nothing of the
 * start was published only when nothing was. */
export function exitedAfterReady(
  component: ManagedComponent,
  target: TargetRecord,
  details: Record<string, unknown>,
  published: boolean,
): RigError {
  const exitCode = details.exitCode;
  return new RigError(
    "PROCESS_EXITED",
    `${component.name} was ready, then exited${typeof exitCode === "number" ? ` with code ${exitCode}` : ""} before ${targetSelector(target)} finished starting.`,
    published
      ? "Inspect the Target logs for why it ended."
      : "Inspect the Target logs for why it ended; nothing of this start was published.",
    details,
  );
}
const ALIVE: HealthCheck = { ready: true };
/** The listener half of activation, and of an ongoing check of a Service's ports, asked of the process that is running now.
 * Not ready while a port the check rests on (every routed port, and every declared port when connections were the evidence)
 * has no listener among the owned processes: whatever answered there was someone else. Nor while a routed port is owned
 * only at an address other than the route's upstream (::1 rather than 127.0.0.1), where the proxy would reach whoever
 * binds it. Throws LISTENER_NONLOCAL for a listener bound beyond loopback and LISTENER_UNKNOWN when the owner or its
 * sockets cannot be established; PROCESS_EXITED when the process ended meanwhile. */
export async function ownedListeners(
  component: ManagedComponent,
  target: TargetRecord,
  effects: Pick<TargetEffects, "listeners">,
  process: SupervisedProcess,
  signal: AbortSignal,
): Promise<HealthCheck> {
  const owner = await process.observe();
  const evidence =
    owner.state === "running" && owner.pid !== undefined
      ? await effects.listeners(owner.pid, signal)
      : undefined;
  await assertAlive(component, process);
  const still = await process.observe();
  if (
    evidence?.state !== "observed" ||
    still.state !== "running" ||
    still.pid !== owner.pid
  )
    throw new RigError(
      "LISTENER_UNKNOWN",
      `What ${component.name} listens on could not be established${evidence?.state === "unknown" ? `: ${evidence.reason}` : "."}`,
      "Rig publishes nothing it cannot inspect. Run rig doctor to check process ownership, then start the Service again.",
      { component: component.name },
    );
  const exposed = evidence.listeners.find(
    (listener) => !loopbackAddress(listener.address),
  );
  if (exposed)
    throw new RigError(
      "LISTENER_NONLOCAL",
      `${component.name} listens on ${exposed.address}:${exposed.port}, which is reachable from outside this machine.`,
      "Bind the Service to 127.0.0.1 or ::1; Rig's proxy is the only public way in.",
      {
        component: component.name,
        address: exposed.address,
        port: exposed.port,
      },
    );
  const routed = routedPorts(target, [component.name]);
  const evidencePorts = new Set([
    ...(component.health ? [] : Object.values(declaredPorts(component))),
    ...routed,
  ]);
  const on = (port: number) =>
    evidence.listeners.filter((listener) => listener.port === port);
  const missing = [...evidencePorts].find((port) => !on(port).length);
  if (missing !== undefined)
    return {
      ready: false,
      reason: `port ${missing} has no listener owned by ${component.name}`,
    };
  // A routed port is reached at the route's upstream address; a listener on another one (::1) leaves that address to
  // whichever program binds it.
  const unreachable = [...routed].find(
    (port) => !on(port).some((listener) => takesUpstream(listener.address)),
  );
  return unreachable === undefined
    ? ALIVE
    : {
        ready: false,
        reason: `${component.name} listens on port ${unreachable} only at ${on(unreachable)[0]!.address}, but Rig's proxy connects to ${routeUpstream(unreachable)}; bind it to ${UPSTREAM_HOST}`,
      };
}
/** The routed ports of a running Service that its own process tree listens on at the route's upstream address now, with
 * nothing of it listening beyond loopback; none when that cannot be established. Never throws: a port it cannot verify
 * stays withheld, and the process is left running as it was. */
export async function ownedRoutedPorts(
  component: ManagedComponent,
  target: TargetRecord,
  effects: Pick<TargetEffects, "listeners">,
  process: SupervisedProcess,
): Promise<number[]> {
  const routed = routedPorts(target, [component.name]);
  if (!routed.size) return [];
  const owner = await process.observe().catch(() => undefined);
  if (owner?.state !== "running" || owner.pid === undefined) return [];
  const evidence = await effects.listeners(
    owner.pid,
    new AbortController().signal,
  );
  const still = await process.observe().catch(() => undefined);
  if (
    evidence.state !== "observed" ||
    still?.state !== "running" ||
    still.pid !== owner.pid ||
    evidence.listeners.some((listener) => !loopbackAddress(listener.address))
  )
    return [];
  return [...routed].filter((port) =>
    evidence.listeners.some(
      (listener) => listener.port === port && takesUpstream(listener.address),
    ),
  );
}
/** IPv4 127.0.0.0/8 and IPv6 ::1, also as an IPv4-mapped address; a wildcard or any other address is reachable from elsewhere. */
export function loopbackAddress(address: string): boolean {
  const mapped = /^::ffff:(.+)$/i.exec(address)?.[1] ?? address;
  return (
    /^127(?:\.\d{1,3}){3}$/.test(mapped) ||
    /^(?:0{0,4}:){2,7}0{0,3}1$/.test(address)
  );
}
/** Without a health check, a component counts as started only once it has outlived the start grace period; `failed`
 * rejecting ends the wait with that failure. */
export async function awaitSurvival(
  component: ManagedComponent,
  timing: ReadinessTiming,
  process: SupervisedProcess,
  failed?: Promise<never>,
): Promise<void> {
  const grace = timing.startGraceMs ?? DEFAULT_START_GRACE_MS;
  const cancels: (() => void)[] = [];
  const checks: Promise<void>[] = [];
  // Every observation is scheduled up front so a crash-and-restart loop cannot hide between polls.
  for (const at of observationTimes(grace))
    checks.push(
      new Promise<void>((resolve) => {
        cancels.push(timing.schedule(at, resolve));
      }).then(() => assertAlive(component, process)),
    );
  try {
    await (failed
      ? Promise.race([Promise.all(checks), failed])
      : Promise.all(checks));
  } finally {
    for (const cancel of cancels) cancel();
  }
}
/** Poll instants within the grace period at the observation cadence, always ending at the grace itself. */
function observationTimes(graceMs: number): number[] {
  const times: number[] = [];
  for (
    let at = OBSERVATION_INTERVAL_MS;
    at < graceMs;
    at += OBSERVATION_INTERVAL_MS
  )
    times.push(at);
  if (graceMs > 0) times.push(graceMs);
  return times;
}
async function assertAlive(
  component: ManagedComponent,
  process: SupervisedProcess,
): Promise<void> {
  const observation = await process.observe();
  if (observation.state !== "stopped") return;
  const exitCode = observation.exitCode;
  // The shell's own exit codes: 127 names a command it could not find, 126 one it could not run.
  const shellFailure =
    exitCode === 127
      ? "the shell found no executable for its command"
      : exitCode === 126
        ? "the shell could not run its command (not executable)"
        : undefined;
  throw new RigError(
    "PROCESS_EXITED",
    exitCode === undefined
      ? `${component.name} exited before it became ready.`
      : `${component.name} exited with code ${exitCode} before it became ready${shellFailure ? `: ${shellFailure}` : ""}.`,
    shellFailure
      ? "Install the missing tool where rigd can find it (rigd uses the PATH it was installed from), or fix the command, then retry."
      : "Inspect Target logs for the start-up failure before retrying.",
    {
      component: component.name,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(observation.signal === undefined
        ? {}
        : { signal: observation.signal }),
    },
  );
}

import {
  writeCaptureObservation,
  type CaptureObservation,
  throttledPublisher,
} from "./capture-observation";
import type { ProcessIdentityReader } from "./process-identity";
import { writeCaptureStatus } from "./capture-status";
import type { Supervisor } from "./contracts";
import { dirname } from "node:path";
import { RigError } from "../domain/errors";
import { readCaptureRequest } from "./capture-request";
import { CAPTURE_KILL_SIGNAL, writeCaptureStop } from "./capture-stop";
import { serviceGraceMs } from "../domain/stop-budget";
import { createChildSupervisor } from "./child-supervisor";
import {
  DEFAULT_LOG_RETENTION,
  hostLogRetention,
  LOG_RETENTION_REFRESH_MS,
} from "../domain/log-retention";
import { readHostConfig } from "../config/documents";
import { runCommand } from "./command-runner";
import {
  createProcessInspection,
  platformKill,
  type ProcessInspection,
} from "./process-inspection";
import { createProcessTiming } from "./process-timing";
/** Unchanged evidence is rewritten this often; the reader trusts evidence younger than one second. */
const OBSERVATION_HEARTBEAT_MS = 250;
/** Signals that ask the wrapper to stop its application within its grace; the wrapper then ends by the same signal.
 * CAPTURE_KILL_SIGNAL asks it to stop the application and cut the grace to the kill wait. */
const STOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
/** Private rigd entrypoint that rigd's child supervisor spawns; owns signal handlers and the captured child lifetime.
 * Runs the requested application until it stops or the wrapper is asked to stop, and returns the wrapper's exit code: the
 * application's own when it stopped by itself. A wrapper asked to stop by a signal stops its application, then ends by that
 * same signal through `endBy`, so rigd's child handle on the wrapper sees a signal rather than a clean exit when the
 * application's own exit record is gone. */
export async function runCapturedProcess(
  requestPath: string,
  dependencies: {
    inspect?: ProcessIdentityReader;
    /** How the wrapper's own supervisor inspects and signals its application; the platform's when absent. */
    processInspection?: ProcessInspection;
    /** Ends this process by `signal` once its handlers are removed; the default raises it on the wrapper itself. */
    endBy?: (signal: NodeJS.Signals) => void;
  } = {},
): Promise<number> {
  const ended = await runUntilStopped(requestPath, dependencies);
  if (ended.signal)
    (dependencies.endBy ?? ((signal) => process.kill(process.pid, signal)))(
      ended.signal,
    );
  return ended.exitCode;
}
async function runUntilStopped(
  requestPath: string,
  dependencies: {
    inspect?: ProcessIdentityReader;
    processInspection?: ProcessInspection;
  },
): Promise<{ exitCode: number; signal?: NodeJS.Signals }> {
  const request = await readCaptureRequest(requestPath);
  // The wrapper is the effect owner: it names the platform runner once and shares it with its supervisor.
  const processInspection =
    dependencies.processInspection ??
    createProcessInspection({
      run: runCommand,
      kill: platformKill,
    });
  const supervisor = createChildSupervisor({
    stateRoot: dirname(requestPath),
    timing: createProcessTiming(),
    processInspection,
    // The wrapper reads the Host's logs settings as rigd does, so every writer of the Target log rotates it alike.
    logRetention: request.configRoot
      ? hostLogRetention({
          read: () => readHostConfig(request.configRoot!),
          now: Date.now,
          refreshMs: LOG_RETENTION_REFRESH_MS,
        })
      : async () => DEFAULT_LOG_RETENTION,
  });
  let stopping: Promise<unknown> | undefined;
  let received: NodeJS.Signals | undefined;
  // The grace is the one the request carries, which the supervisor outside waits out before it would end this wrapper.
  const kill = new AbortController();
  const stop = () => {
    stopping ??= supervisor
      .stop(request.key, {
        graceMs: request.stopGraceMs ?? serviceGraceMs(undefined),
        kill: kill.signal,
      })
      .then(async (result) => {
        // Said before the wrapper ends, so whoever stopped it can tell the application needed SIGKILL.
        if (result.killed)
          await writeCaptureStop(requestPath, {
            incarnation: request.incarnation,
            killed: result.killed,
          }).catch(() => {});
      });
  };
  const handlers = [
    ...STOP_SIGNALS.map((signal) => {
      const handler = () => {
        received ??= signal;
        stop();
      };
      process.on(signal, handler);
      return [signal, handler] as const;
    }),
    // A kill is a stop that skips the grace: it ends the wrapper as a SIGTERM stop does.
    (() => {
      const handler = () => {
        received ??= "SIGTERM";
        kill.abort();
        stop();
      };
      process.on(CAPTURE_KILL_SIGNAL, handler);
      return [CAPTURE_KILL_SIGNAL, handler] as const;
    })(),
  ];
  const ended = (exitCode: number) =>
    received ? { exitCode, signal: received } : { exitCode };
  const inspect = dependencies.inspect ?? processInspection.identity;
  let applicationPid: number | undefined;
  try {
    const wrapperIdentity = await inspect(process.pid);
    if (!wrapperIdentity)
      throw new RigError(
        "PROCESS_INSPECT",
        "Capture wrapper identity unavailable.",
        "Check process inspection permissions.",
      );
    const started = await supervisor.ensureRunning(request);
    applicationPid = started.pid!;
    await writeCaptureStatus(requestPath, {
      state: "running",
      pid: applicationPid,
    });
    // Idle evidence is rewritten only at the heartbeat, well inside the reader's freshness window.
    const publish = throttledPublisher(
      (
        observation: CaptureObservation["observation"],
        applicationIdentity?: string,
      ) =>
        writeCaptureObservation(requestPath, {
          wrapperPid: process.pid,
          wrapperIdentity,
          observedAt: Date.now(),
          applicationIdentity,
          observation,
        }),
      { heartbeatMs: OBSERVATION_HEARTBEAT_MS, now: Date.now },
    );
    try {
      return ended(
        await observeUntilStopped({
          supervisor,
          key: request.key,
          inspect,
          publish,
          stopping: () => stopping,
        }),
      );
    } catch (error) {
      // The component was running; stopping it deliberately beats leaving it unobserved.
      stop();
      await stopping;
      const message = `The capture wrapper could no longer observe the running component (${describe(error)}) and stopped it.`;
      await publish({ state: "stopped", reason: message });
      await writeCaptureStatus(requestPath, {
        state: "stopped",
        pid: applicationPid,
        message,
      });
      return ended(1);
    }
  } catch (error) {
    if (applicationPid === undefined)
      await writeCaptureStatus(requestPath, {
        state: "failed",
        message: `The managed component could not start (${describe(error)}).`,
      });
    return ended(1);
  } finally {
    // A kill that arrives after the stop must not end the wrapper by its own signal: it ends by the one that stopped it.
    if (!process.listeners(CAPTURE_KILL_SIGNAL).includes(ignoreLateKill))
      process.on(CAPTURE_KILL_SIGNAL, ignoreLateKill);
    for (const [signal, handler] of handlers)
      process.removeListener(signal, handler);
    await supervisor.shutdown();
  }
}
/** Stays installed once the wrapper's stop is over, until it exits. */
function ignoreLateKill(): void {}
/** Publishes fresh application evidence until the application stops or a stop was requested; returns the exit code. */
async function observeUntilStopped(input: {
  supervisor: Pick<Supervisor, "observe">;
  key: string;
  inspect: ProcessIdentityReader;
  publish: (
    observation: CaptureObservation["observation"],
    applicationIdentity?: string,
  ) => Promise<void>;
  stopping: () => Promise<unknown> | undefined;
}): Promise<number> {
  let applicationPid: number | undefined;
  let applicationIdentity: string | undefined;
  while (!input.stopping()) {
    const state = await input.supervisor.observe(input.key);
    if (state.state === "running" && state.pid !== applicationPid) {
      applicationIdentity = state.pid
        ? await input.inspect(state.pid)
        : undefined;
      applicationPid = state.pid;
    }
    await input.publish(
      state,
      state.state === "running" ? applicationIdentity : undefined,
    );
    if (state.state === "stopped") return state.exitCode ?? 1;
    await Bun.sleep(50);
  }
  await input.stopping();
  return 0;
}
function describe(error: unknown): string {
  return error instanceof RigError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
}

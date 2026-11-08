import {
  changePublisher,
  writeCaptureObservation,
  type CaptureObservation,
} from "./capture-observation";
import type { ProcessIdentityReader } from "./process-identity";
import { writeCaptureStatus } from "./capture-status";
import type { Supervisor } from "./contracts";
import { dirname } from "node:path";
import { RigError } from "../domain/errors";
import { captureRequestRoot, readCaptureRequest } from "./capture-request";
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
  platformInspection,
  type ProcessInspection,
} from "./process-inspection";
import { createProcessTiming } from "./process-timing";
import { elapsedNow } from "./system-clock";
/** Signals that ask the wrapper to stop its application within its grace; the wrapper then ends by the same signal.
 * CAPTURE_KILL_SIGNAL asks it to stop the application and cut the grace to the kill wait. */
const STOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
/** How many times, this far apart, the wrapper reads its own identity before it gives up its start. */
const IDENTITY_ATTEMPTS = 5;
const IDENTITY_RETRY_MS = 100;
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
    /** What the wrapper waits on between looks at its application; `wakeablePause` when absent. */
    pause?: ReturnType<typeof wakeablePause>;
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
    pause?: ReturnType<typeof wakeablePause>;
  },
): Promise<{ exitCode: number; signal?: NodeJS.Signals }> {
  const root = captureRequestRoot(requestPath);
  const request = await readCaptureRequest(root, requestPath);
  // The wrapper is the effect owner: it names the platform runner once and shares it with its supervisor.
  const processInspection =
    dependencies.processInspection ??
    createProcessInspection(await platformInspection(runCommand));
  const pause = dependencies.pause ?? wakeablePause();
  const supervisor = createChildSupervisor({
    stateRoot: dirname(requestPath),
    root,
    timing: createProcessTiming(),
    processInspection,
    // The application's exit, a change in whether its output is recorded, and a stop each wake the wrapper; nothing else
    // changes what it observes, so it sets no timer.
    onChange: pause.wake,
    // The wrapper reads the Host's logs settings as rigd does, so every writer of the Target log rotates it alike.
    logRetention: request.configRoot
      ? hostLogRetention({
          read: () => readHostConfig(request.configRoot!),
          elapsed: elapsedNow,
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
          await writeCaptureStop(root, requestPath, {
            incarnation: request.incarnation,
            killed: result.killed,
          }).catch(() => {});
      });
    pause.wake();
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
    // rigd 1.1.0 refuses an observation without the wrapper's identity and time, so a rigd downgraded while this wrapper
    // runs would take its application for unknown: both are still written, though nothing here reads them, and no
    // application starts without the identity, as under 1.1.0's wrapper.
    const wrapperIdentity = await ownIdentity(processInspection.identity);
    const started = await supervisor.ensureRunning(request);
    applicationPid = started.pid!;
    await writeCaptureStatus(root, requestPath, {
      state: "running",
      pid: applicationPid,
    });
    const publish = changePublisher(
      (
        observation: CaptureObservation["observation"],
        applicationIdentity?: string,
      ) =>
        writeCaptureObservation(root, requestPath, {
          wrapperPid: process.pid,
          wrapperIdentity,
          observedAt: Date.now(),
          applicationIdentity,
          observation,
        }),
    );
    try {
      return ended(
        await observeUntilStopped({
          supervisor,
          key: request.key,
          inspect,
          publish,
          stopping: () => stopping,
          pause: () => pause.wait(),
        }),
      );
    } catch (error) {
      // The component was running; stopping it deliberately beats leaving it unobserved.
      stop();
      await stopping;
      const message = `The capture wrapper could no longer observe the running component (${describe(error)}) and stopped it.`;
      await publish({ state: "stopped", reason: message });
      await writeCaptureStatus(root, requestPath, {
        state: "stopped",
        pid: applicationPid,
        message,
      });
      return ended(1);
    }
  } catch (error) {
    if (applicationPid === undefined)
      await writeCaptureStatus(root, requestPath, {
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
/** This process's birth identity, read again after a failed or empty read; PROCESS_INSPECT once IDENTITY_ATTEMPTS reads
 * found none. */
async function ownIdentity(identity: ProcessIdentityReader): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const found = await identity(process.pid).catch(() => undefined);
    if (found) return found;
    if (attempt === IDENTITY_ATTEMPTS)
      throw new RigError(
        "PROCESS_INSPECT",
        "Capture wrapper identity unavailable.",
        "Check process inspection permissions.",
      );
    await new Promise((resolve) => setTimeout(resolve, IDENTITY_RETRY_MS));
  }
}
/** Stays installed once the wrapper's stop is over, until it exits. */
function ignoreLateKill(): void {}
/** A pause `wake` ends, or `ms` when given. A wake while nothing pauses ends the next pause at once, so none is lost; a
 * timer goes with its pause, so it never holds the wrapper open as it exits. */
export function wakeablePause() {
  let woken = false;
  let end: (() => void) | undefined;
  return {
    wake() {
      if (end) end();
      else woken = true;
    },
    wait: (ms?: number) =>
      new Promise<void>((resolve) => {
        if (woken) {
          woken = false;
          resolve();
          return;
        }
        const finish = () => {
          clearTimeout(timer);
          end = undefined;
          resolve();
        };
        const timer = ms === undefined ? undefined : setTimeout(finish, ms);
        end = finish;
      }),
  };
}
/** Publishes application evidence as it changes, looking once per `pause`, until the application stops or a stop was
 * requested; returns the exit code. */
export async function observeUntilStopped(input: {
  supervisor: Pick<Supervisor, "observe">;
  key: string;
  inspect: ProcessIdentityReader;
  publish: (
    observation: CaptureObservation["observation"],
    applicationIdentity?: string,
  ) => Promise<void>;
  stopping: () => Promise<unknown> | undefined;
  pause: () => Promise<void>;
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
    await input.pause();
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

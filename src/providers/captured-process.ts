import {
  writeCaptureObservation,
  type CaptureObservation,
  throttledPublisher,
} from "./capture-observation";
import {
  createProcessIdentityReader,
  type ProcessIdentityReader,
} from "./process-identity";
import { writeCaptureStatus } from "./capture-status";
import type { Supervisor } from "./contracts";
import { dirname } from "node:path";
import { RigError } from "../domain/errors";
import { readCaptureRequest } from "./capture-request";
import { createChildSupervisor } from "./child-supervisor";
import { runCommand } from "./command-runner";
import { createProcessInspection, platformKill } from "./process-inspection";
import { createProcessTiming } from "./process-timing";
/** Private rigd entrypoint used by launchd; owns signal handlers and the captured child lifetime. */
/** Unchanged evidence is rewritten this often; the reader trusts evidence younger than one second. */
const OBSERVATION_HEARTBEAT_MS = 250;
export async function runCapturedProcess(
  requestPath: string,
  dependencies: { inspect?: ProcessIdentityReader } = {},
): Promise<number> {
  const request = await readCaptureRequest(requestPath);
  const supervisor = createChildSupervisor({
    stateRoot: dirname(requestPath),
    timing: createProcessTiming(),
    processInspection: createProcessInspection({
      run: runCommand,
      kill: platformKill,
    }),
  });
  let stopping: Promise<unknown> | undefined;
  const stop = () => {
    stopping ??= supervisor.stop(request.key);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  const inspect = dependencies.inspect ?? createProcessIdentityReader();
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
      return await observeUntilStopped({
        supervisor,
        key: request.key,
        inspect,
        publish,
        stopping: () => stopping,
      });
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
      return 1;
    }
  } catch (error) {
    if (applicationPid === undefined)
      await writeCaptureStatus(requestPath, {
        state: "failed",
        message: `The managed component could not start (${describe(error)}).`,
      });
    return 1;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGHUP", stop);
    await supervisor.shutdown();
  }
}
/** Publishes fresh application evidence until the application stops for good or a stop was requested; returns the exit code. */
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
    if (state.state === "stopped" && !state.restartPending)
      return state.exitCode ?? 1;
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

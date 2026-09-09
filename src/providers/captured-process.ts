import { writeCaptureObservation } from "./capture-observation";
import { createProcessIdentityReader } from "./process-identity";
import { writeCaptureStatus } from "./capture-status";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { RigError } from "../domain/errors";
import { z } from "zod";
import { createChildSupervisor } from "./child-supervisor";
const requestSchema = z.object({
  key: z.string().min(1),
  componentName: z.string().min(1),
  command: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()),
  logRoot: z.string().min(1),
  keepAlive: z.boolean().optional(),
});
/** Private rigd entrypoint used by launchd; owns signal handlers and the captured child lifetime. */
export async function runCapturedProcess(requestPath: string): Promise<number> {
  const request = requestSchema.parse(
    JSON.parse(await readFile(requestPath, "utf8")),
  );
  const supervisor = createChildSupervisor({ stateRoot: dirname(requestPath) });
  let stopping: Promise<unknown> | undefined;
  const stop = () => {
    stopping ??= supervisor.stop(request.key);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  try {
    const inspect = createProcessIdentityReader();
    const wrapperIdentity = await inspect(process.pid);
    if (!wrapperIdentity)
      throw new RigError(
        "PROCESS_INSPECT",
        "Capture wrapper identity unavailable.",
        "Check process inspection permissions.",
      );
    const started = await supervisor.ensureRunning(request);
    let applicationPid: number | undefined;
    let applicationIdentity: string | undefined;
    await writeCaptureStatus(requestPath, {
      state: "running",
      pid: started.pid!,
    });
    while (!stopping) {
      const observedAt = Date.now();
      const state = await supervisor.observe(request.key);
      if (state.state === "running" && state.pid !== applicationPid) {
        applicationIdentity = state.pid ? await inspect(state.pid) : undefined;
        applicationPid = state.pid;
      }
      await writeCaptureObservation(requestPath, {
        wrapperPid: process.pid,
        wrapperIdentity,
        observedAt,
        applicationIdentity:
          state.state === "running" ? applicationIdentity : undefined,
        observation: state,
      });
      if (state.state === "stopped" && !state.restartPending)
        return state.exitCode ?? 1;
      await Bun.sleep(50);
    }
    await stopping;
    return 0;
  } catch {
    await writeCaptureStatus(requestPath, {
      state: "failed",
      message: "The managed component could not start.",
    });
    return 1;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGHUP", stop);
    await supervisor.shutdown();
  }
}

import { writeCaptureStatus } from "./capture-status";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
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
    const started = await supervisor.ensureRunning(request);
    await writeCaptureStatus(requestPath, {
      state: "running",
      pid: started.pid!,
    });
    while (!stopping) {
      const state = await supervisor.observe(request.key);
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

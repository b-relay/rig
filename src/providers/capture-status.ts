import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RigError } from "../domain/errors";
const statusSchema = z.discriminatedUnion("state", [
  z.object({
    state: z
      .literal("running")
      .describe("The managed app acquired a verified process."),
    pid: z.number().int().positive().describe("The app process identifier."),
  }),
  z.object({
    state: z.literal("failed").describe("The app could not start."),
    message: z.string().describe("Safe startup failure explanation."),
  }),
  z.object({
    state: z
      .literal("stopped")
      .describe(
        "The app had started and the capture wrapper stopped it deliberately after it could no longer observe it.",
      ),
    pid: z
      .number()
      .int()
      .positive()
      .describe("The stopped app process identifier."),
    message: z
      .string()
      .describe("Safe explanation of why the wrapper stopped the app."),
  }),
]);
export type CaptureStatus = z.infer<typeof statusSchema>;
export async function clearCaptureStatus(requestPath: string): Promise<void> {
  await rm(`${requestPath}.status.json`, { force: true });
}
export async function writeCaptureStatus(
  requestPath: string,
  status: CaptureStatus,
): Promise<void> {
  const path = `${requestPath}.status.json`,
    temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(status), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
/** How long a managed app may take to confirm startup once its wrapper exists; the supervisors pass it explicitly. */
export const DEFAULT_CAPTURE_START_MS = 5000;
/** Poll cadence while the status file is absent. */
const CAPTURE_START_POLL_MS = 20;
/** The clock the startup poll lives by; a supervisor passes the timing it already holds, a test a scripted one. */
export interface CaptureStartWait {
  /** Budget on `now`'s clock before the wait fails as PROCESS_START_TIMEOUT. */
  readonly timeoutMs: number;
  /** Unix milliseconds. */
  now(): number;
  /** Resolves once `ms` have elapsed on the same clock. */
  wait(ms: number): Promise<void>;
}
/** The wrapper's process existence does not prove that its managed app started. */
export async function waitForCaptureStart(
  requestPath: string,
  wait: CaptureStartWait,
): Promise<number> {
  const deadline = wait.now() + wait.timeoutMs;
  while (wait.now() < deadline) {
    const raw = await readFile(`${requestPath}.status.json`, "utf8").catch(
      (error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (raw) {
      const status = statusSchema.parse(JSON.parse(raw));
      if (status.state !== "running")
        throw new RigError(
          "PROCESS_START",
          status.message,
          "Check the component executable and Target logs.",
        );
      return status.pid;
    }
    await wait.wait(CAPTURE_START_POLL_MS);
  }
  throw new RigError(
    "PROCESS_START_TIMEOUT",
    "The managed component did not confirm startup.",
    "Inspect the Target logs and retry.",
  );
}

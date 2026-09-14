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
/** The wrapper's process existence does not prove that its managed app started. */
export async function waitForCaptureStart(
  requestPath: string,
  timeoutMs = 5000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
    await Bun.sleep(20);
  }
  throw new RigError(
    "PROCESS_START_TIMEOUT",
    "The managed component did not confirm startup.",
    "Inspect the Target logs and retry.",
  );
}

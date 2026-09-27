import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StopKill } from "./contracts";
import { readCaptureRequest } from "./capture-request";

/** The signal that tells a capture wrapper to cut its application's grace short: SIGTERM, then SIGKILL after the kill wait.
 * SIGUSR1 is left alone because runtimes reserve it for their debugger. */
export const CAPTURE_KILL_SIGNAL = "SIGUSR2" as const;

const stopRecordSchema = z.object({
  incarnation: z.string().min(1).describe("The start whose stop this was."),
  killed: z
    .enum(["timeout", "request"])
    .describe(
      "Why the application needed SIGKILL: its grace ran out, or a kill cut the grace short.",
    ),
});
const stopRecordPath = (requestPath: string) => `${requestPath}.stop.json`;
/** Written by the capture wrapper once it had to SIGKILL its application, so the supervisor that stopped the wrapper can say
 * so after the wrapper has gone. Replaced whole. */
export async function writeCaptureStop(
  requestPath: string,
  record: z.infer<typeof stopRecordSchema>,
): Promise<void> {
  const path = stopRecordPath(requestPath),
    temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
/** Why the wrapper of the request at `requestPath` had to SIGKILL its application, when its record names the start that
 * request carries; undefined when it did not, or nothing readable says so. */
export async function readCaptureStop(
  requestPath: string,
): Promise<StopKill | undefined> {
  const [raw, request] = await Promise.all([
    readFile(stopRecordPath(requestPath), "utf8").catch(() => undefined),
    readCaptureRequest(requestPath).catch(() => undefined),
  ]);
  if (raw === undefined) return undefined;
  try {
    const record = stopRecordSchema.parse(JSON.parse(raw));
    return request && record.incarnation !== request.incarnation
      ? undefined
      : record.killed;
  } catch {
    return undefined;
  }
}
export async function removeCaptureStop(requestPath: string): Promise<void> {
  await rm(stopRecordPath(requestPath), { force: true });
}
/** Whether the wrapper running the request at `requestPath` understands CAPTURE_KILL_SIGNAL: only a request that carries
 * its grace was written for such a wrapper. An older wrapper would be ended by the signal and leave its application
 * unsignalled, so it is never sent one. */
export async function understandsKill(requestPath: string): Promise<boolean> {
  const request = await readCaptureRequest(requestPath).catch(() => undefined);
  return request?.stopGraceMs !== undefined;
}

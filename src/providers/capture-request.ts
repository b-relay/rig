import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RigError } from "../domain/errors";
import type { ManagedProcess } from "./contracts";
const captureRequestSchema = z.object({
  key: z.string().min(1),
  componentName: z.string().min(1),
  command: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()),
  logRoot: z.string().min(1),
  incarnation: z.string().min(1),
});
export type CaptureRequest = z.infer<typeof captureRequestSchema>;
/** The wrapper reads the request on its own schedule, so it is replaced whole: a reader sees the previous or the new document, never a partial one. */
export async function writeCaptureRequest(
  requestPath: string,
  request: ManagedProcess,
): Promise<void> {
  const temporary = `${requestPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(request), { mode: 0o600 });
    await rename(temporary, requestPath);
  } finally {
    await rm(temporary, { force: true });
  }
}
/** Fails as CAPTURE_REQUEST naming the path when the document is absent, unreadable, or not a capture request. */
export async function readCaptureRequest(
  requestPath: string,
): Promise<CaptureRequest> {
  let raw: string;
  try {
    raw = await readFile(requestPath, "utf8");
  } catch (error) {
    throw invalid(requestPath, (error as NodeJS.ErrnoException).code ?? "read");
  }
  try {
    return captureRequestSchema.parse(JSON.parse(raw));
  } catch {
    throw invalid(requestPath, "content");
  }
}
const invalid = (path: string, cause: string) =>
  new RigError(
    "CAPTURE_REQUEST",
    `The capture request ${path} is missing or not a capture request (${cause}).`,
    "Start the Target again so rigd rewrites its capture request.",
    { path, cause },
  );

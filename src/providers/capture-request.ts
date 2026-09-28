import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RigError } from "../domain/errors";
import type { ManagedProcess } from "./contracts";
import type { LogRetention } from "./target-log";
const captureRequestSchema = z.object({
  key: z.string().min(1),
  componentName: z.string().min(1),
  command: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()),
  logRoot: z.string().min(1),
  incarnation: z.string().min(1),
  /** The application's grace after SIGTERM, from its Service's stop_timeout; a request written by an older rigd has none. */
  stopGraceMs: z.number().int().nonnegative().optional(),
  /** How the wrapper rotates the Target log it writes; a request written by an older rigd has none and gets the default. */
  logRetention: z
    .object({
      maxBytes: z.number().int().positive(),
      generations: z.number().int().nonnegative(),
    })
    .optional(),
});
export type CaptureRequest = z.infer<typeof captureRequestSchema>;
/** The document a capture wrapper reads: the process to run and, when the supervisor has one, its log retention. */
export function captureDocument(
  request: ManagedProcess,
  logRetention: LogRetention | undefined,
): CaptureRequest {
  return {
    ...request,
    command: [...request.command],
    ...(logRetention ? { logRetention } : {}),
  };
}
/** The wrapper reads the request on its own schedule, so it is replaced whole: a reader sees the previous or the new document, never a partial one. */
export async function writeCaptureRequest(
  requestPath: string,
  request: ManagedProcess,
  logRetention?: LogRetention,
): Promise<void> {
  const temporary = `${requestPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify(captureDocument(request, logRetention)),
      { mode: 0o600 },
    );
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

import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { readPrivateFile, replacePrivateFile } from "./private-files";
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
  /** The application's grace after SIGTERM, from its Service's stop_timeout; a request written by an older rigd has none. */
  stopGraceMs: z.number().int().nonnegative().optional(),
  /** The Rig root whose config.yaml `logs` settings the wrapper rotates the Target log by, read as rigd reads them; a
   * request written by an older rigd has none and gets the defaults. */
  configRoot: z.string().min(1).optional(),
});
export type CaptureRequest = z.infer<typeof captureRequestSchema>;
/** The document a capture wrapper reads: the process to run and, when the supervisor has one, the Rig root whose logs
 * settings it rotates by. */
function captureDocument(
  request: ManagedProcess,
  configRoot: string | undefined,
): CaptureRequest {
  return {
    ...request,
    command: [...request.command],
    ...(configRoot ? { configRoot } : {}),
  };
}
/** The Rig root of the request at `requestPath`, for the capture wrapper, which is handed nothing but that path: rigd writes
 * requests only in its root's `capture` directory, so a path anywhere else is refused (CAPTURE_REQUEST) rather than taken
 * to name a root. */
export function captureRequestRoot(requestPath: string): string {
  const directory = dirname(resolve(requestPath));
  if (basename(directory) !== "capture")
    throw invalid(requestPath, "not in a capture directory");
  return dirname(directory);
}
/** The wrapper reads the request on its own schedule, so it is replaced whole: a reader sees the previous or the new document,
 * never a partial one. `root` is the Rig root whose capture directory holds `requestPath`. */
export async function writeCaptureRequest(
  root: string,
  requestPath: string,
  request: ManagedProcess,
  configRoot?: string,
): Promise<void> {
  await replacePrivateFile(
    root,
    requestPath,
    JSON.stringify(captureDocument(request, configRoot)),
  );
}
/** The wrapper runs the command a request names as the user, so it reads only a request the user's rigd could have written:
 * a regular file, not a link, that the user owns and no one else can write, in a capture directory that is the user's alone
 * (RIG_FILE_UNTRUSTED or RIG_ROOT_UNSAFE otherwise). Fails as CAPTURE_REQUEST naming the path when the document is absent,
 * unreadable, or not a capture request. */
export async function readCaptureRequest(
  root: string,
  requestPath: string,
): Promise<CaptureRequest> {
  let raw: string;
  try {
    raw = await readPrivateFile(root, requestPath);
  } catch (error) {
    if (error instanceof RigError) throw error;
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

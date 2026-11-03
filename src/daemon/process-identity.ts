import { nativeProcessStart } from "../providers/native-process-start";

/** How a process recorded by pid relates to what is running now. */
export type ProcessLiveness =
  /** The pid exists and its start time matches the record. */
  | "running"
  /** No process has this pid. */
  | "exited"
  /** The pid exists but belongs to a process started at another time. */
  | "replaced"
  /** The pid exists and the record carries no start time (written by an older rigd). */
  | "unverified";
export interface ProcessRecord {
  pid: number;
  /** Start time as ps reports it; the identity a pid alone cannot give. */
  startedAt?: string;
}
/** Whether any process has this pid; a permission refusal still means it exists. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
/** Start time of the process as ps reports it, or undefined when no such process exists. Effect owner over /bin/ps. */
export async function processStartTime(
  pid: number,
): Promise<string | undefined> {
  const child = Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "lstart="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [code, output] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  const startedAt = output.trim();
  return code === 0 && startedAt ? startedAt : undefined;
}
/** Whether the kernel's start time for the pid, printed as ps would print it here, reads exactly as the record does, which
 * starts no process. Any other answer proves nothing. */
async function kernelConfirms(record: ProcessRecord): Promise<boolean> {
  const native = await nativeProcessStart();
  try {
    const seconds = native?.start(record.pid);
    return (
      seconds !== undefined && native?.printed(seconds) === record.startedAt
    );
  } catch {
    return false;
  }
}
/** Whether the recorded process is still the one running. Exit is decided by
 * signal 0; a record without a start time can only be unverified. This runs before every request a client sends, so the
 * kernel is asked first, and ps only when it does not confirm the record. */
export async function recordedProcess(
  record: ProcessRecord,
): Promise<ProcessLiveness> {
  if (!processExists(record.pid)) return "exited";
  if (record.startedAt === undefined) return "unverified";
  if (await kernelConfirms(record)) return "running";
  const startedAt = await processStartTime(record.pid);
  if (startedAt === undefined) return "exited";
  return startedAt === record.startedAt ? "running" : "replaced";
}

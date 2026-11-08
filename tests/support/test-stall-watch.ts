/* The thread that keeps test-stall.ts's limit. Each message is the test process's latest progress; when none follows within
 * the limit, it writes what the process is in and what it is doing straight to stderr, and kills the process. */
import { writeSync } from "node:fs";

declare const self: Worker;
type Progress = {
  readonly file?: string;
  readonly begun: number;
  readonly ended: number;
  readonly at: number;
  readonly stallMs: number;
};
/** Where the process is, as far as `progress` shows: a file is seen only once its hooks or tests run. */
function whereStalled({ file, begun, ended }: Progress) {
  if (file === undefined)
    return "before any test file's hooks or tests ran: in loading the first file, or its first hooks";
  if (begun > ended)
    return `in a test of ${file} (${begun} began, ${ended} ended)`;
  return `in ${file} with no test running (${begun} began and ended): in its hooks, or in loading the next file or its hooks`;
}
/** How long each piece of evidence may take to gather. */
const EVIDENCE_MS = 15_000;
let timer: ReturnType<typeof setTimeout> | undefined;
self.onmessage = ({ data }: MessageEvent<Progress>) => {
  clearTimeout(timer);
  timer = setTimeout(() => void stalled(data), data.stallMs);
};
/** Says where the process stalled, with its child processes and its threads' stacks, then kills it. */
async function stalled(progress: Progress) {
  const say = (text: string) => writeSync(2, `${text}\n`);
  say(
    `\nTest stall: no test has begun or ended for ${progress.stallMs / 1000} s, since ` +
      `${new Date(progress.at).toISOString()}, ${whereStalled(progress)}. Bun's own timeouts did not end it, so its thread is blocked or waits on something they do not reach. ` +
      `Its child processes and its threads follow; then test process ${process.pid} is killed, and what its fixtures ` +
      `started is not cleaned up.`,
  );
  say(`--- child processes of ${process.pid}`);
  say(
    childProcesses(
      await output([
        "/bin/ps",
        "-axo",
        "pid=,ppid=,pgid=,etime=,stat=,command=",
      ]),
    ),
  );
  say(`--- threads of ${process.pid}`);
  // The list of loaded libraries that ends the report says nothing about the stall.
  const stacks = await output([
    "/usr/bin/sample",
    String(process.pid),
    "2",
    "-file",
    "/dev/stdout",
  ]);
  say(stacks.split("\nBinary Images:")[0]!);
  process.kill(process.pid, "SIGKILL");
}
/** The rows of a `ps` listing that descend from this process, but for the `ps` that made it. */
function childProcesses(listing: string) {
  const rows = listing.split("\n").flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s/.exec(line);
    return row && !line.includes("pid=,ppid=")
      ? [{ pid: Number(row[1]), ppid: Number(row[2]), line }]
      : [];
  });
  const ours = new Set([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows)
      if (ours.has(row.ppid) && !ours.has(row.pid)) {
        ours.add(row.pid);
        grew = true;
      }
  }
  const children = rows.filter(
    (row) => row.pid !== process.pid && ours.has(row.pid),
  );
  if (rows.length === 0) return listing;
  return children.length
    ? children.map((row) => row.line).join("\n")
    : "(none)";
}
/** What `command` printed, within EVIDENCE_MS; a command that cannot run, or runs past it, says so instead. The test's
 * thread may be what is blocked, so nothing here waits on it. */
async function output(command: string[]) {
  try {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), EVIDENCE_MS);
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    return code === 0
      ? stdout
      : `${command[0]} exited with ${code}: ${stderr.trim()}\n${stdout}`;
  } catch (error) {
    return `${command[0]} could not run: ${error}`;
  }
}

import { RigError } from "../domain/errors";
import type { ProcessReading } from "../domain/usage-sample";
import type { CommandRunner } from "./contracts";
import type { ProcessUsageReader } from "./process-usage";

const ENV = { LC_ALL: "C", PATH: "/usr/sbin:/usr/bin:/bin" };
const BUDGET_MS = 4000;

/** One row of the process table. */
interface ProcessRow extends ProcessReading {
  readonly ppid: number;
  readonly pgid: number;
}

/** Reads process usage with one `/bin/ps` call for every root together, for a Host where the native reader is
 * unavailable. Starting `ps` costs a few milliseconds of CPU, so it is asked every 5 s rather than every second. Memory
 * is the resident set, which counts shared memory and so reads higher than the physical footprint the native reader
 * gives. */
export function createPsProcessUsageReader(
  run: CommandRunner,
): ProcessUsageReader {
  return {
    intervalMs: 5000,
    kind: "ps",
    async read(roots) {
      const table = await run({
        command: ["/bin/ps", "-axo", "pid=,ppid=,pgid=,time=,rss="],
        env: ENV,
        timeoutMs: BUDGET_MS,
      });
      if (table.exitCode !== 0)
        throw new RigError(
          "PROCESS_TABLE_UNREADABLE",
          "The process table could not be read for usage sampling.",
          "Check that /bin/ps runs for the user rigd runs as; rigd tries again at the next sample.",
          { exitCode: table.exitCode, stderr: table.stderr.slice(0, 500) },
        );
      const rows = parseProcessTable(table.stdout);
      const trees = new Map<number, readonly ProcessReading[]>();
      for (const root of roots) {
        const tree = processTree(rows, root);
        if (tree) trees.set(root, tree);
      }
      return trees;
    },
  };
}

/** Pure: the rows of `ps -axo pid=,ppid=,pgid=,time=,rss=`. A line that does not parse is skipped. */
export function parseProcessTable(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5) continue;
    const [pid, ppid, pgid, rss] = [
      fields[0],
      fields[1],
      fields[2],
      fields[4],
    ].map(Number);
    const cpuSeconds = cpuTimeSeconds(fields[3]!);
    if (
      ![pid, ppid, pgid, rss].every(Number.isInteger) ||
      cpuSeconds === undefined
    )
      continue;
    rows.push({
      pid: pid!,
      ppid: ppid!,
      pgid: pgid!,
      cpuNs: cpuSeconds * 1e9,
      memoryBytes: rss! * 1024,
    });
  }
  return rows;
}

/** Pure: seconds from `ps`'s cumulative CPU time: `[[dd-]hh:]mm:ss.ss`. */
export function cpuTimeSeconds(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
}

/** Pure: the root's row, its descendants, and every member of a process group one of them leads; `undefined` when the
 * root is not in the table. */
function processTree(
  rows: readonly ProcessRow[],
  root: number,
): ProcessReading[] | undefined {
  if (!rows.some((row) => row.pid === root)) return undefined;
  const owned = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows)
      if (!owned.has(row.pid) && (owned.has(row.ppid) || owned.has(row.pgid))) {
        owned.add(row.pid);
        grew = true;
      }
  }
  return rows
    .filter((row) => owned.has(row.pid))
    .map(({ pid, cpuNs, memoryBytes }) => ({ pid, cpuNs, memoryBytes }));
}

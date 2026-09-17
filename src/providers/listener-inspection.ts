import type { CommandRunner } from "./contracts";

/** One TCP socket in the listening state. `address` is the bound host as the OS reports it, without brackets: `127.0.0.1`,
 * `::1`, or `*` for every interface. */
export interface OwnedListener {
  readonly pid: number;
  readonly address: string;
  readonly port: number;
}
/** `unknown` is never a claim that nothing listens: the process tree or its sockets could not be read. */
export type ListenerEvidence =
  | { readonly state: "observed"; readonly listeners: readonly OwnedListener[] }
  | { readonly state: "unknown"; readonly reason: string };
/** What a process and its descendants listen on at the moment of the call. It says nothing about before or after: a process
 * may bind later, or have bound and closed already. Whether an address is acceptable is the caller's policy. */
export interface ListenerInspection {
  /** `pid` is a process the caller has just verified it owns. Never rejects; an inspection that cannot answer is `unknown`. */
  inspect(pid: number, signal?: AbortSignal): Promise<ListenerEvidence>;
}

const ENV = { LC_ALL: "C", PATH: "/usr/sbin:/usr/bin:/bin" };
const BUDGET_MS = 5000;

/** Reads the process table with `ps` and listening sockets with `lsof`. Descendants are the children of `pid`, recursively,
 * and every member of its process group, which still holds a child whose parent already exited. */
export function createListenerInspection(
  run: CommandRunner,
): ListenerInspection {
  return {
    async inspect(pid, signal) {
      try {
        const table = await run({
          command: ["/bin/ps", "-axo", "pid=,ppid=,pgid="],
          env: ENV,
          timeoutMs: BUDGET_MS,
          ...(signal ? { signal } : {}),
        });
        if (table.exitCode !== 0)
          return unknown("The process table could not be read.");
        const owned = processTree(table.stdout, pid);
        if (!owned)
          return unknown(`Process ${pid} is not in the process table.`);
        const sockets = await run({
          command: [
            "/usr/sbin/lsof",
            "-nP",
            "-iTCP",
            "-sTCP:LISTEN",
            "-a",
            "-p",
            owned.join(","),
            "-Fn",
          ],
          env: ENV,
          timeoutMs: BUDGET_MS,
          ...(signal ? { signal } : {}),
        });
        // lsof exits 1 when it lists nothing, and also when one of several processes ended meanwhile; only silence on stderr
        // tells those from a failed inspection.
        if (
          sockets.timedOut ||
          sockets.stderr.trim() ||
          (sockets.exitCode !== 0 && sockets.exitCode !== 1)
        )
          return unknown("Listening sockets could not be read.");
        const listeners = parseListeners(sockets.stdout);
        return listeners
          ? { state: "observed", listeners }
          : unknown(
              "Listening sockets were reported in a form Rig does not read.",
            );
      } catch (error) {
        return unknown(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
function unknown(reason: string): ListenerEvidence {
  return { state: "unknown", reason };
}
/** `pid` with its descendants and group members, or nothing when `pid` is not a row of the table. */
function processTree(table: string, pid: number): number[] | undefined {
  const rows = table
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((row) => row.length === 3 && row.every(Number.isInteger));
  if (!rows.some(([id]) => id === pid)) return undefined;
  const owned = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [id, parent, group] of rows)
      if (!owned.has(id!) && (owned.has(parent!) || group === pid)) {
        owned.add(id!);
        grew = true;
      }
  }
  return [...owned];
}
/** lsof field output: a `p<pid>` line opens a process, each `n<host>:<port>` line under it is one listener. */
function parseListeners(output: string): OwnedListener[] | undefined {
  const listeners: OwnedListener[] = [];
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (!line.startsWith("n")) continue;
    const match = /^n(?:\[(.+)\]|([^:\[\]]+)):(\d{1,5})$/.exec(line);
    if (!match || pid === undefined || !Number.isInteger(pid)) return undefined;
    listeners.push({
      pid,
      address: match[1] ?? match[2]!,
      port: Number(match[3]),
    });
  }
  return listeners;
}

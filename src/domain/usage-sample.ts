/** What one Component, Target, Project, the Host or Rig itself used at one moment. */
export interface UsageSample {
  /** CPU over the last sampling interval, Activity Monitor style: 100 is one full core, so a busy Component can read 350. */
  readonly cpuPercent: number;
  /** Physical memory footprint in bytes: the memory figure Activity Monitor shows. */
  readonly memoryBytes: number;
}

/** One process as the OS reports it at one moment. */
export interface ProcessReading {
  readonly pid: number;
  /** When the process started, in the reader's own clock: with `pid` it names one process, so a pid the OS hands to
   * another process later is never compared with the first. */
  readonly started: number;
  /** CPU time the process has used since it started, user and system together, in nanoseconds. */
  readonly cpuNs: number;
  readonly memoryBytes: number;
}

/** Pure: the key one process is known by across readings: its pid and when it started. */
export function processKey(
  reading: Pick<ProcessReading, "pid" | "started">,
): string {
  return `${reading.pid}@${reading.started}`;
}

/** Pure: a tree's reading as the next `treeUsage` measures from: each process's CPU time by `processKey`. */
export function cpuByProcess(
  readings: readonly ProcessReading[],
): Map<string, number> {
  return new Map(
    readings.map((reading) => [processKey(reading), reading.cpuNs]),
  );
}

/** Pure: what a process tree used over the interval since the previous reading of the same tree.
 *
 * CPU is the CPU time each process gained, summed, over the wall time between the readings. A process that was not in
 * the previous reading (by pid and start, so a reused pid is a new process) started during the interval, so all of its
 * CPU time falls in it; it is capped at every core busy for the whole interval, which a process missed by an earlier
 * reading could otherwise exceed. CPU is `undefined` when there is no previous reading of the tree to measure from, as
 * at the first sight of a Component. Memory is the sum of the footprints now. */
export function treeUsage(input: {
  /** The previous reading of the same tree (`cpuByProcess`). Absent at the first sight of the tree. */
  readonly previous: ReadonlyMap<string, number> | undefined;
  readonly current: readonly ProcessReading[];
  /** Wall time since the previous reading, in nanoseconds. */
  readonly elapsedNs: number;
  /** Logical cores on the Host: the most CPU time a process can gain per nanosecond of wall time. */
  readonly cores: number;
}): { readonly cpuPercent: number | undefined; readonly memoryBytes: number } {
  const memoryBytes = input.current.reduce(
    (sum, process) => sum + process.memoryBytes,
    0,
  );
  if (input.previous === undefined || input.elapsedNs <= 0)
    return { cpuPercent: undefined, memoryBytes };
  const ceiling = input.elapsedNs * input.cores;
  let gained = 0;
  for (const process of input.current) {
    const before = input.previous.get(processKey(process));
    gained +=
      before !== undefined
        ? Math.max(0, process.cpuNs - before)
        : Math.min(process.cpuNs, ceiling);
  }
  return {
    cpuPercent: (Math.min(gained, ceiling) / input.elapsedNs) * 100,
    memoryBytes,
  };
}

/** Pure: the sum of several samples taken at the same moment: a Target's Components, a Project's Targets, the Host's
 * Projects. `undefined` when there are none. */
export function sumSamples(
  samples: Iterable<UsageSample>,
): UsageSample | undefined {
  let cpuPercent = 0;
  let memoryBytes = 0;
  let any = false;
  for (const sample of samples) {
    cpuPercent += sample.cpuPercent;
    memoryBytes += sample.memoryBytes;
    any = true;
  }
  return any ? { cpuPercent, memoryBytes } : undefined;
}

/** Pure: a CPU share as Activity Monitor shows it: one decimal below 10%, whole percents from there. */
export function formatCpu(percent: number): string {
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

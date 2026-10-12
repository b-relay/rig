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
  /** CPU time the process has used since it started, user and system together, in nanoseconds. */
  readonly cpuNs: number;
  readonly memoryBytes: number;
}

/** Pure: what a process tree used over the interval since the previous reading of the same tree.
 *
 * CPU is the CPU time each process gained, summed, over the wall time between the readings. A process that was not in
 * the previous reading started during the interval, so all of its CPU time falls in it; it is capped at every core busy
 * for the whole interval, which a process missed by an earlier reading could otherwise exceed. A process whose CPU time
 * went down is a new process that reused a pid and counts as new. CPU is `undefined` when there is no previous reading
 * of the tree to measure from, as at the first sight of a Component. Memory is the sum of the footprints now. */
export function treeUsage(input: {
  /** The previous reading of the same tree: pid to its CPU time then. Absent at the first sight of the tree. */
  readonly previous: ReadonlyMap<number, number> | undefined;
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
    const before = input.previous.get(process.pid);
    gained +=
      before !== undefined && process.cpuNs >= before
        ? process.cpuNs - before
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

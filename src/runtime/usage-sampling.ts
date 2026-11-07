import {
  cpuByProcess,
  processKey,
  treeUsage,
  type ProcessReading,
  type UsageSample,
} from "../domain/usage-sample";
import type { ProcessUsageReader } from "../providers/process-usage";
import { seriesKey } from "./usage-history";
import type { MonitoredProcess } from "./usage-sampler";

/** How often the set of running processes is read again from rigd's records when nothing new appears. */
export const PROCESS_REFRESH_MS = 5000;
/** Something new under rigd (a Job run starting, most often) has its processes read again after at most this long. */
const NEWCOMER_REFRESH_MS = 1000;
const RIG = seriesKey({ scope: "rig" });

/** What the processes rigd knows of used at one moment. */
export interface TreeSample {
  /** Milliseconds on the monotonic clock: when the trees were read. */
  readonly at: number;
  /** Unix seconds: which second the samples are stored in. */
  readonly second: number;
  /** Each Component measured, in the order rigd's records list them. */
  readonly components: readonly {
    readonly series: MonitoredProcess["series"];
    readonly sample: UsageSample;
  }[];
  /** Rig itself, when it had a process and a previous reading to measure from. */
  readonly rig: UsageSample | undefined;
}

/** The process trees rigd samples, read and measured one look at a time. Each look reads the trees of every running
 * Component and of Rig itself (rigd, Rig's Caddy, and every capture wrapper, whether rigd started it or adopted it
 * after a restart) and measures each tree against its previous reading. A Component's first look has no CPU to
 * measure from and is not measured. CPU is measured over the monotonic time between the reads that returned the CPU
 * counters, never the time a look began. Looks must not overlap. */
export function createTreeSampling(deps: {
  readonly reader: ProcessUsageReader;
  /** Every running Service and Job run, from rigd's records and its supervisor. */
  readonly processes: () => Promise<readonly MonitoredProcess[]>;
  /** rigd's own pid and Rig's Caddy's, when known. Their trees count as Rig itself, less the Components in them. */
  readonly rigProcesses: () => Promise<readonly number[]>;
  /** Milliseconds since the Unix epoch: which second a sample is stored in. */
  readonly now: () => number;
  /** Milliseconds on a monotonic clock: what CPU time is divided by, and when rigd's records are read again. */
  readonly elapsed: () => number;
  /** Logical cores on the Host. */
  readonly cores: number;
}): {
  /** Reads the trees once and measures them. Rejects when rigd's records or the process table cannot be read. */
  look(): Promise<TreeSample>;
  /** Forgets a Project's previous readings, and reads rigd's records again at the next look. */
  forget(projectId: string): void;
} {
  let running: (KnownProcesses & { readonly at: number }) | undefined;
  /** Each tree's previous reading, by series key: when it was read (monotonic) and each process's CPU time then. */
  const previous = new Map<string, { at: number; cpu: Map<string, number> }>();
  /** The processes the last look counted as Rig itself (by `processKey`), and those of them a later look at rigd's
   * records still found in no Component: a helper rigd keeps running, such as a healthcheck command, is new only once,
   * while a Job run that began just before a look is new until a look after it. */
  let seenAsRig = new Set<string>();
  let countedAsRig = new Set<string>();

  const discover = async () => ({
    at: deps.elapsed(),
    processes: await deps.processes(),
    rig: await deps.rigProcesses(),
  });
  const rootsOf = (known: KnownProcesses) => [
    ...new Set([
      ...known.processes.map((each) => each.wrapperPid),
      ...known.rig,
    ]),
  ];
  /** The trees of every known process, reading rigd's records again when they are due or when something new appears. */
  const acquire = async () => {
    // A look at rigd's records confirms as Rig itself only what was already counted so before it.
    let confirmable: ReadonlySet<string> = countedAsRig;
    const rediscover = () => {
      confirmable = seenAsRig;
      return discover();
    };
    let known =
      running && deps.elapsed() - running.at < PROCESS_REFRESH_MS
        ? running
        : await rediscover();
    running = known;
    let trees = await deps.reader.read(rootsOf(known));
    let at = deps.elapsed();
    // A process under rigd that is none of the known ones is most often a Job run that just began: read rigd's records
    // again now rather than count it towards Rig itself until the next refresh.
    if (
      at - known.at >= NEWCOMER_REFRESH_MS &&
      hasNewcomer(known, trees, countedAsRig)
    ) {
      known = await rediscover();
      running = known;
      trees = await deps.reader.read(rootsOf(known));
      at = deps.elapsed();
    }
    return { known, trees, at, confirmable };
  };
  const measure = (
    key: string,
    readings: readonly ProcessReading[],
    at: number,
  ): UsageSample | undefined => {
    const before = previous.get(key);
    const usage = treeUsage({
      previous: before?.cpu,
      current: readings,
      elapsedNs: before ? (at - before.at) * 1e6 : 0,
      cores: deps.cores,
    });
    previous.set(key, { at, cpu: cpuByProcess(readings) });
    return usage.cpuPercent === undefined
      ? undefined
      : { cpuPercent: usage.cpuPercent, memoryBytes: usage.memoryBytes };
  };

  return {
    async look() {
      const { known, trees, at, confirmable } = await acquire();
      const second = Math.floor(deps.now() / 1000);
      const owners = attributed(known, trees);
      seenAsRig = new Set(owners.rig.map(processKey));
      countedAsRig = new Set(
        [...seenAsRig].filter((key) => confirmable.has(key)),
      );
      const components = owners.components.flatMap(({ series, readings }) => {
        const sample = measure(seriesKey(series), readings, at);
        return sample ? [{ series, sample }] : [];
      });
      const rig =
        owners.rig.length > 0 ? measure(RIG, owners.rig, at) : undefined;
      const sampled = new Set([
        RIG,
        ...known.processes.map((each) => seriesKey(each.series)),
      ]);
      for (const key of previous.keys())
        if (!sampled.has(key)) previous.delete(key);
      return { at, second, components, rig };
    },
    forget(projectId) {
      for (const key of previous.keys())
        if (key.startsWith(`component:${projectId}:`)) previous.delete(key);
      running = undefined;
    },
  };
}

/** The processes rigd's records name: each Component's capture wrapper, and rigd and Rig's Caddy. */
interface KnownProcesses {
  readonly processes: readonly MonitoredProcess[];
  readonly rig: readonly number[];
}

/** Pure: whose each reading of one look at the trees is. A Component has every process below its wrapper, and is
 * listed only when it has one; Rig itself has the rest of the trees of rigd and Caddy and every wrapper, each process
 * once, by pid. */
export function attributed(
  known: KnownProcesses,
  trees: ReadonlyMap<number, readonly ProcessReading[]>,
): {
  readonly components: readonly {
    readonly series: MonitoredProcess["series"];
    readonly readings: readonly ProcessReading[];
  }[];
  readonly rig: readonly ProcessReading[];
} {
  const components: {
    series: MonitoredProcess["series"];
    readings: ProcessReading[];
  }[] = [];
  const inComponents = new Set<number>();
  const wrappers: ProcessReading[] = [];
  for (const { series, wrapperPid } of known.processes) {
    const tree = trees.get(wrapperPid) ?? [];
    const readings = tree.filter((reading) => reading.pid !== wrapperPid);
    wrappers.push(...tree.filter((reading) => reading.pid === wrapperPid));
    for (const reading of readings) inComponents.add(reading.pid);
    if (readings.length > 0) components.push({ series, readings });
  }
  const rig = new Map<number, ProcessReading>();
  for (const reading of [
    ...known.rig.flatMap((pid) => trees.get(pid) ?? []),
    ...wrappers,
  ])
    if (!inComponents.has(reading.pid)) rig.set(reading.pid, reading);
  return { components, rig: [...rig.values()] };
}

/** Pure: whether a Rig tree holds a process that is new: not rigd or Caddy, not in a known Component tree, and not one
 * the last look already counted as Rig itself. */
export function hasNewcomer(
  known: KnownProcesses,
  trees: ReadonlyMap<number, readonly ProcessReading[]>,
  countedAsRig: ReadonlySet<string>,
): boolean {
  const familiar = new Set<number>(known.rig);
  for (const { wrapperPid } of known.processes)
    for (const reading of trees.get(wrapperPid) ?? [])
      familiar.add(reading.pid);
  return known.rig.some((pid) =>
    (trees.get(pid) ?? []).some(
      (reading) =>
        !familiar.has(reading.pid) && !countedAsRig.has(processKey(reading)),
    ),
  );
}

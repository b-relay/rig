import {
  storedSample,
  SLOTS_PER_MINUTE,
  type StoredSample,
} from "../domain/usage-minute";
import {
  cpuByProcess,
  processKey,
  sumSamples,
  treeUsage,
  type ProcessReading,
  type UsageSample,
} from "../domain/usage-sample";
import type { ProcessUsageReader } from "../providers/process-usage";
import {
  seriesKey,
  type RecordedMinute,
  type UsageHistory,
  type UsageSeries,
} from "./usage-history";

type ComponentSeries = Extract<UsageSeries, { scope: "component" }>;

/** A running Service or Job run, and the capture wrapper rigd started it under: the Component is everything below the
 * wrapper, and the wrapper's own small use counts towards Rig itself. */
export interface MonitoredProcess {
  readonly series: ComponentSeries;
  readonly wrapperPid: number;
}

/** How long usage history is kept: the Host config's `monitor` settings. */
export interface UsageRetention {
  readonly detailHours: number;
  readonly retentionDays: number;
}

/** The newest sample of one series. */
export interface LatestSample {
  readonly series: UsageSeries;
  readonly sample: UsageSample;
  /** Unix seconds. */
  readonly at: number;
}

/** What the sampler holds that a report must see beside stored history: the newest sample of every series sampled in
 * the last pass, and the minutes it is still filling or has not yet written. */
export interface UsageSnapshot {
  readonly latest: readonly LatestSample[];
  readonly pending: readonly RecordedMinute[];
}

export interface UsageSampler {
  /** Samples every running Component, its Target, Project, the Host and Rig itself once, and writes changed minutes or
   * prunes old history when either is due. Rejects when the process table cannot be read, and on every pass while
   * history cannot be written or pruned, so the failure stays on doctor's notice until a write or prune succeeds; the
   * samples stay buffered meanwhile. */
  pass(): Promise<void>;
  /** What is sampled but not stored, as of the last pass. */
  snapshot(): UsageSnapshot;
  /** Writes every changed minute now, as rigd does before it stops. */
  flush(): Promise<void>;
  /** Drops everything buffered for a Project and removes its stored history, as `rig forget` does. Waits for a pass in
   * progress, so no sample taken before the forget is recorded after it. */
  forget(projectId: string): Promise<void>;
}

/** How often the set of running processes is read again from rigd's records when nothing new appears. */
export const PROCESS_REFRESH_MS = 5000;
/** Something new under rigd (a Job run starting, most often) has its processes read again after at most this long. */
const NEWCOMER_REFRESH_MS = 1000;
/** How often changed minutes are written: a crash loses at most this much. */
export const USAGE_FLUSH_MS = 30_000;
/** How soon a failed write is tried again. */
const FLUSH_RETRY_MS = 5000;
/** How often history past retention is pruned, and how soon a failed prune is tried again. */
export const USAGE_PRUNE_MS = 3_600_000;
const PRUNE_RETRY_MS = 60_000;
/** At most this many finished minutes wait for a failing store; older ones are dropped. */
const PENDING_LIMIT = 10_000;
const RIG = seriesKey({ scope: "rig" });

/** rigd's usage sampler. Each pass reads the process trees of every running Component and of Rig itself (rigd, Rig's
 * Caddy, and every capture wrapper, whether rigd started it or adopted it after a restart), turns them into samples,
 * sums them into Target, Project and Host totals for that second, and buffers them by minute. The Host total includes
 * Rig itself. A Component's first pass has no CPU to measure from and is not recorded. CPU is measured over the
 * monotonic time between the reads that returned the CPU counters, never the time a pass began. */
export function createUsageSampler(deps: {
  readonly reader: ProcessUsageReader;
  /** Every running Service and Job run, from rigd's records and its supervisor. */
  readonly processes: () => Promise<readonly MonitoredProcess[]>;
  /** rigd's own pid and Rig's Caddy's, when known. Their trees count as Rig itself, less the Components in them. */
  readonly rigProcesses: () => Promise<readonly number[]>;
  readonly history: UsageHistory;
  readonly retention: () => Promise<UsageRetention>;
  /** Milliseconds since the Unix epoch: which second a sample is stored in. */
  readonly now: () => number;
  /** Milliseconds on a monotonic clock: what CPU time is divided by, and when work is due. */
  readonly elapsed: () => number;
  /** Logical cores on the Host. */
  readonly cores: number;
}): UsageSampler {
  let running:
    | {
        readonly at: number;
        readonly processes: readonly MonitoredProcess[];
        readonly rig: readonly number[];
      }
    | undefined;
  /** Each tree's previous reading, by series key: when it was read (monotonic) and each process's CPU time then. */
  const previous = new Map<string, { at: number; cpu: Map<string, number> }>();
  const minutes = createMinuteBuffer();
  let latest: LatestSample[] = [];
  /** The processes the last pass counted as Rig itself (by `processKey`), and those of them a later look at rigd's
   * records still found in no Component: a helper rigd keeps running, such as a healthcheck command, is new only once,
   * while a Job run that began just before a look is new until a look after it. */
  let seenAsRig = new Set<string>();
  let countedAsRig = new Set<string>();
  let flushDueAt: number | undefined;
  let pruneDueAt: number | undefined;
  let flushFailure: unknown;
  let pruneFailure: unknown;
  // Passes, flushes and forgets run one at a time.
  let turn: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = turn.then(work);
    turn = run.catch(() => {});
    return run;
  };

  const discover = async () => ({
    at: deps.elapsed(),
    processes: await deps.processes(),
    rig: await deps.rigProcesses(),
  });
  const rootsOf = (known: NonNullable<typeof running>) => [
    ...new Set([
      ...known.processes.map((each) => each.wrapperPid),
      ...known.rig,
    ]),
  ];
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
  const writeChanged = async () => {
    await deps.history.write(minutes.changed());
    minutes.written(Math.floor(deps.now() / 60_000));
  };

  return {
    pass: () =>
      exclusive(async () => {
        // A look at rigd's records confirms as Rig itself only what was already counted so before it.
        let confirmable: ReadonlySet<string> = countedAsRig;
        const rediscover = () => {
          confirmable = seenAsRig;
          return discover();
        };
        running =
          running && deps.elapsed() - running.at < PROCESS_REFRESH_MS
            ? running
            : await rediscover();
        let trees = await deps.reader.read(rootsOf(running));
        let at = deps.elapsed();
        // A process under rigd that is none of the known ones is most often a Job run that just began: read rigd's
        // records again now rather than count it towards Rig itself until the next refresh.
        if (
          at - running.at >= NEWCOMER_REFRESH_MS &&
          hasNewcomer(running, trees, countedAsRig)
        ) {
          running = await rediscover();
          trees = await deps.reader.read(rootsOf(running));
          at = deps.elapsed();
        }
        const second = Math.floor(deps.now() / 1000);

        const components: {
          series: ComponentSeries;
          sample: UsageSample;
        }[] = [];
        const inComponents = new Set<number>();
        const wrappers: ProcessReading[] = [];
        for (const { series, wrapperPid } of running.processes) {
          const tree = trees.get(wrapperPid) ?? [];
          const readings = tree.filter((reading) => reading.pid !== wrapperPid);
          wrappers.push(
            ...tree.filter((reading) => reading.pid === wrapperPid),
          );
          for (const reading of readings) inComponents.add(reading.pid);
          const sample =
            readings.length > 0
              ? measure(seriesKey(series), readings, at)
              : undefined;
          if (sample) components.push({ series, sample });
        }
        const rigReadings = new Map<number, ProcessReading>();
        for (const reading of [
          ...running.rig.flatMap((pid) => trees.get(pid) ?? []),
          ...wrappers,
        ])
          if (!inComponents.has(reading.pid))
            rigReadings.set(reading.pid, reading);
        seenAsRig = new Set([...rigReadings.values()].map(processKey));
        countedAsRig = new Set(
          [...seenAsRig].filter((key) => confirmable.has(key)),
        );
        const rig =
          rigReadings.size > 0
            ? measure(RIG, [...rigReadings.values()], at)
            : undefined;

        latest = totalsOf(components, rig).map(({ series, sample }) => {
          minutes.record(series, storedSample(sample), second);
          return { series, sample, at: second };
        });
        const sampled = new Set([
          RIG,
          ...running.processes.map((each) => seriesKey(each.series)),
        ]);
        for (const key of previous.keys())
          if (!sampled.has(key)) previous.delete(key);

        flushDueAt ??= at + USAGE_FLUSH_MS;
        if (at >= flushDueAt) {
          try {
            await writeChanged();
            flushFailure = undefined;
            flushDueAt = at + USAGE_FLUSH_MS;
          } catch (error) {
            flushFailure = error;
            flushDueAt = at + FLUSH_RETRY_MS;
          }
        }
        if (pruneDueAt === undefined || at >= pruneDueAt) {
          try {
            const retention = await deps.retention();
            await deps.history.prune({
              detailBefore: second - retention.detailHours * 3600,
              historyBefore: second - retention.retentionDays * 86_400,
            });
            pruneFailure = undefined;
            pruneDueAt = at + USAGE_PRUNE_MS;
          } catch (error) {
            pruneFailure = error;
            pruneDueAt = at + PRUNE_RETRY_MS;
          }
        }
        if (flushFailure !== undefined) throw flushFailure;
        if (pruneFailure !== undefined) throw pruneFailure;
      }),
    snapshot() {
      return { latest, pending: minutes.pending() };
    },
    flush: () => exclusive(writeChanged),
    forget: (projectId) =>
      exclusive(async () => {
        const ofProject = (series: UsageSeries) =>
          "projectId" in series && series.projectId === projectId;
        minutes.drop(ofProject);
        latest = latest.filter((each) => !ofProject(each.series));
        for (const key of previous.keys())
          if (key.startsWith(`component:${projectId}:`)) previous.delete(key);
        running = undefined;
        await deps.history.forget(projectId);
      }),
  };
}

/** Whether a Rig tree holds a process that is new: not rigd or Caddy, not in a known Component tree, and not one the
 * last pass already counted as Rig itself. */
function hasNewcomer(
  known: {
    readonly processes: readonly MonitoredProcess[];
    readonly rig: readonly number[];
  },
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

/** Pure: every sample of one second, Components first, then each Target's, each Project's, Rig itself's and the Host's
 * total. A Target or Project with no sampled Component has no total; the Host's is absent only when nothing at all was
 * sampled. */
export function totalsOf(
  components: readonly {
    readonly series: ComponentSeries;
    readonly sample: UsageSample;
  }[],
  rig: UsageSample | undefined,
): { series: UsageSeries; sample: UsageSample }[] {
  const targets = grouped(components, ({ series }) => {
    const { component: _name, componentKind: _kind, ...target } = series;
    return { ...target, scope: "target" } as const;
  });
  const projects = grouped(targets, ({ series }) => ({
    scope: "project" as const,
    projectId: series.projectId,
    project: series.project,
  }));
  const parts = [
    ...projects,
    ...(rig ? [{ series: { scope: "rig" } as const, sample: rig }] : []),
  ];
  const host = sumSamples(parts.map((part) => part.sample));
  return [
    ...components,
    ...targets,
    ...parts,
    ...(host ? [{ series: { scope: "host" } as const, sample: host }] : []),
  ];
}

/** Pure: the total of each group `groupOf` puts samples in, in order of first appearance. */
function grouped<S extends UsageSeries, G extends UsageSeries>(
  samples: readonly { readonly series: S; readonly sample: UsageSample }[],
  groupOf: (part: { readonly series: S }) => G,
): { series: G; sample: UsageSample }[] {
  const groups = new Map<string, { series: G; samples: UsageSample[] }>();
  for (const part of samples) {
    const series = groupOf(part);
    const key = seriesKey(series);
    const group = groups.get(key) ?? { series, samples: [] };
    group.samples.push(part.sample);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ series, samples: parts }) => ({
    series,
    sample: sumSamples(parts)!,
  }));
}

interface OpenMinute {
  series: UsageSeries;
  readonly minute: number;
  readonly slots: (StoredSample | undefined)[];
  /** It holds a sample its last write did not take. */
  dirty: boolean;
}

/** Samples by series and minute: the minute each series is filling now, and finished minutes not written yet. Only
 * minutes that changed since their last write are written again. The sampler runs its passes and writes one at a time,
 * so nothing is recorded while a write is in progress. */
function createMinuteBuffer() {
  const open = new Map<string, OpenMinute>();
  let finished: RecordedMinute[] = [];
  return {
    /** Puts a sample in its second's slot; a series' earlier minute is finished when its next one begins, and kept for
     * writing only if it changed since its last write. */
    record(series: UsageSeries, sample: StoredSample, second: number) {
      const key = seriesKey(series);
      const minute = Math.floor(second / 60);
      let buffer = open.get(key);
      if (buffer && buffer.minute !== minute) {
        if (buffer.dirty) finished.push(copyOf(buffer));
        buffer = undefined;
      }
      buffer ??= {
        series,
        minute,
        slots: Array<StoredSample | undefined>(SLOTS_PER_MINUTE).fill(
          undefined,
        ),
        dirty: false,
      };
      buffer.series = series;
      buffer.slots[second % 60] = sample;
      buffer.dirty = true;
      open.set(key, buffer);
      if (finished.length > PENDING_LIMIT)
        finished = finished.slice(-PENDING_LIMIT);
    },
    /** What a write should take: every finished minute and every open one that changed since it was last written. */
    changed(): RecordedMinute[] {
      return [
        ...finished,
        ...[...open.values()].filter((buffer) => buffer.dirty).map(copyOf),
      ];
    },
    /** After a successful write of what `changed` returned: everything is stored as it is now. An open minute that
     * ended before `currentMinute` (Unix minutes) began is let go. */
    written(currentMinute: number) {
      finished = [];
      for (const [key, buffer] of open) {
        buffer.dirty = false;
        if (buffer.minute < currentMinute - 1) open.delete(key);
      }
    },
    /** Every minute a report must lay over stored history: finished ones not written, and every open one. */
    pending(): RecordedMinute[] {
      return [...finished, ...[...open.values()].map(copyOf)];
    },
    /** Drops every minute of the series `matches` selects. */
    drop(matches: (series: UsageSeries) => boolean) {
      finished = finished.filter((minute) => !matches(minute.series));
      for (const [key, buffer] of open)
        if (matches(buffer.series)) open.delete(key);
    },
  };
}

function copyOf(buffer: RecordedMinute): RecordedMinute {
  return {
    series: buffer.series,
    minute: buffer.minute,
    slots: [...buffer.slots],
  };
}

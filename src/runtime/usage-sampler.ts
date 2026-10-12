import {
  storedSample,
  SLOTS_PER_MINUTE,
  type StoredSample,
} from "../domain/usage-minute";
import {
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
 * wrapper, so the wrapper's own small use counts towards Rig itself. */
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

/** What the sampler holds that is not stored yet: the newest sample of every series sampled in the last pass, and the
 * minutes not yet written. A report merges it with stored history so charts reach the current second. */
export interface UsageSnapshot {
  readonly latest: readonly LatestSample[];
  readonly pending: readonly RecordedMinute[];
}

export interface UsageSampler {
  /** Samples every running Component, its Target, Project, the Host and Rig itself once, and writes buffered minutes or
   * prunes old history when either is due. Rejects when the process table cannot be read or history cannot be written;
   * the samples stay buffered for the next pass to write. */
  pass(): Promise<void>;
  /** What is sampled but not stored, as of the last pass. */
  snapshot(): UsageSnapshot;
  /** Writes every buffered minute now, as rigd does before it stops. */
  flush(): Promise<void>;
  /** Drops everything buffered for a Project and removes its stored history, as `rig forget` does. */
  forget(projectId: string): Promise<void>;
}

/** How often the set of running processes is read again from rigd's records: a Component that starts is sampled
 * within this time. */
export const PROCESS_REFRESH_MS = 5000;
/** How often buffered minutes are written: a crash loses at most this much. */
export const USAGE_FLUSH_MS = 30_000;
/** How often history past retention is pruned. */
export const USAGE_PRUNE_MS = 3_600_000;
/** At most this many finished minutes wait for a failing store; older ones are dropped. */
const PENDING_LIMIT = 10_000;
/** The key Rig itself's previous reading is kept under, beside the Components' series keys. */
const RIG = seriesKey({ scope: "rig" });

/** rigd's usage sampler. Each pass reads the process trees of every running Component and of Rig itself (rigd, the
 * capture wrappers, and Rig's Caddy), turns them into samples, sums them into Target, Project and Host totals for that
 * same second, and buffers them by minute. The Host total includes Rig itself. A Component's first pass has no CPU to
 * measure from and is not recorded. */
export function createUsageSampler(deps: {
  readonly reader: ProcessUsageReader;
  /** Every running Service and Job run, from rigd's records and its supervisor. */
  readonly processes: () => Promise<readonly MonitoredProcess[]>;
  /** rigd's own pid and Rig's Caddy's, when known. Their whole trees count as Rig itself, less the Components in them. */
  readonly rigProcesses: () => Promise<readonly number[]>;
  readonly history: UsageHistory;
  readonly retention: () => Promise<UsageRetention>;
  /** Milliseconds since the Unix epoch. */
  readonly now: () => number;
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
  /** Each tree's previous reading, by series key: when it was taken, and each process's CPU time then. */
  const previous = new Map<string, { at: number; cpu: Map<number, number> }>();
  const minutes = createMinuteBuffer();
  let latest: LatestSample[] = [];
  let flushedAt: number | undefined;
  let prunedAt: number | undefined;

  /** The sample of one tree since its previous reading, which this reading replaces. */
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
    previous.set(key, {
      at,
      cpu: new Map(readings.map((reading) => [reading.pid, reading.cpuNs])),
    });
    return usage.cpuPercent === undefined
      ? undefined
      : { cpuPercent: usage.cpuPercent, memoryBytes: usage.memoryBytes };
  };

  const flush = async () => {
    await deps.history.write(minutes.unwritten());
    minutes.written(Math.floor(deps.now() / 60_000));
  };

  return {
    async pass() {
      const at = deps.now();
      const second = Math.floor(at / 1000);
      if (!running || at - running.at >= PROCESS_REFRESH_MS)
        running = {
          at,
          processes: await deps.processes(),
          rig: await deps.rigProcesses(),
        };
      const trees = await deps.reader.read([
        ...new Set([
          ...running.processes.map((each) => each.wrapperPid),
          ...running.rig,
        ]),
      ]);

      const components: { series: ComponentSeries; sample: UsageSample }[] = [];
      const inComponents = new Set<number>();
      for (const { series, wrapperPid } of running.processes) {
        const readings = (trees.get(wrapperPid) ?? []).filter(
          (reading) => reading.pid !== wrapperPid,
        );
        for (const reading of readings) inComponents.add(reading.pid);
        const sample =
          readings.length > 0
            ? measure(seriesKey(series), readings, at)
            : undefined;
        if (sample) components.push({ series, sample });
      }
      const rigReadings = running.rig
        .flatMap((pid) => trees.get(pid) ?? [])
        .filter((reading) => !inComponents.has(reading.pid));
      const rig =
        rigReadings.length > 0
          ? measure(
              RIG,
              [...new Map(rigReadings.map((r) => [r.pid, r])).values()],
              at,
            )
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

      flushedAt ??= at;
      if (at - flushedAt >= USAGE_FLUSH_MS) {
        flushedAt = at;
        await flush();
      }
      if (prunedAt === undefined || at - prunedAt >= USAGE_PRUNE_MS) {
        prunedAt = at;
        const retention = await deps.retention();
        await deps.history.prune({
          detailBefore: second - retention.detailHours * 3600,
          historyBefore: second - retention.retentionDays * 86_400,
        });
      }
    },
    snapshot() {
      return { latest, pending: minutes.unwritten() };
    },
    flush,
    async forget(projectId) {
      const ofProject = (series: UsageSeries) =>
        "projectId" in series && series.projectId === projectId;
      minutes.drop(ofProject);
      latest = latest.filter((each) => !ofProject(each.series));
      await deps.history.forget(projectId);
    },
  };
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

/** Samples by series and minute, until they are written: the minute filling now, and finished minutes a failing store
 * has not taken yet. */
function createMinuteBuffer() {
  const open = new Map<
    string,
    { series: UsageSeries; minute: number; slots: (StoredSample | undefined)[] }
  >();
  let finished: RecordedMinute[] = [];
  return {
    /** Puts a sample in its second's slot; a series' earlier minute is finished when its next one begins. */
    record(series: UsageSeries, sample: StoredSample, second: number) {
      const key = seriesKey(series);
      const minute = Math.floor(second / 60);
      const buffer = open.get(key);
      if (buffer && buffer.minute !== minute) finished.push(copyOf(buffer));
      const current =
        buffer && buffer.minute === minute
          ? buffer
          : {
              series,
              minute,
              slots: Array<StoredSample | undefined>(SLOTS_PER_MINUTE).fill(
                undefined,
              ),
            };
      current.series = series;
      current.slots[second % 60] = sample;
      open.set(key, current);
      if (finished.length > PENDING_LIMIT)
        finished = finished.slice(-PENDING_LIMIT);
    },
    /** Every finished minute and a copy of every open one. */
    unwritten(): RecordedMinute[] {
      return [...finished, ...[...open.values()].map(copyOf)];
    },
    /** After a write of what `unwritten` returned: finished minutes are dropped, and so are open ones that ended before
     * `currentMinute` (Unix minutes) began, which no sample will fill any more. */
    written(currentMinute: number) {
      finished = [];
      for (const [key, buffer] of open)
        if (buffer.minute < currentMinute - 1) open.delete(key);
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

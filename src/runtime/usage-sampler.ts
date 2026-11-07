import {
  storedSample,
  SLOTS_PER_MINUTE,
  type StoredSample,
} from "../domain/usage-minute";
import { sumSamples, type UsageSample } from "../domain/usage-sample";
import type { ProcessUsageReader } from "../providers/process-usage";
import {
  seriesKey,
  type RecordedMinute,
  type UsageHistory,
  type UsageSeries,
} from "./usage-history";
import {
  maintained,
  pruneBefore,
  type MaintenancePolicy,
  type MaintenanceState,
} from "./usage-maintenance";
import { createTreeSampling } from "./usage-sampling";

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
  /** Runs `read` with the snapshot between passes, flushes and forgets, so what it reads from the store matches what
   * the sampler holds: nothing is written, pruned or forgotten until it finishes. Reports read this way. */
  consistently<T>(read: (snapshot: UsageSnapshot) => Promise<T>): Promise<T>;
  /** Writes every changed minute now, as rigd does before it stops. */
  flush(): Promise<void>;
  /** Drops everything buffered for a Project and removes its stored history, as `rig forget` does. Waits for a pass in
   * progress, so no sample taken before the forget is recorded after it. */
  forget(projectId: string): Promise<void>;
}

export { PROCESS_REFRESH_MS } from "./usage-sampling";
/** How often changed minutes are written: a crash loses at most this much. */
export const USAGE_FLUSH_MS = 30_000;
/** How often history past retention is pruned. */
export const USAGE_PRUNE_MS = 3_600_000;
/** Changed minutes are first written a whole interval after the first pass, and a failed write is tried again soon. */
const FLUSH: MaintenancePolicy = {
  everyMs: USAGE_FLUSH_MS,
  retryMs: 5000,
  first: "wait",
};
/** The first pass prunes, and a failed prune is tried again after a minute. */
const PRUNE: MaintenancePolicy = {
  everyMs: USAGE_PRUNE_MS,
  retryMs: 60_000,
  first: "run",
};
/** At most this many finished minutes wait for a failing store; older ones are dropped. */
const PENDING_LIMIT = 10_000;

/** rigd's usage sampler. Each pass samples the process trees of every running Component and of Rig itself
 * (`createTreeSampling`), sums them into Target, Project and Host totals for that second, buffers them by minute, and
 * then writes or prunes history when either is due. The Host total includes Rig itself. */
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
  const trees = createTreeSampling(deps);
  const minutes = createMinuteBuffer();
  let latest: LatestSample[] = [];
  let flushing: MaintenanceState = {};
  let pruning: MaintenanceState = {};
  // Passes, flushes and forgets run one at a time.
  let turn: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = turn.then(work);
    turn = run.catch(() => {});
    return run;
  };

  const writeChanged = async () => {
    await deps.history.write(minutes.changed());
    minutes.written(Math.floor(deps.now() / 60_000));
  };
  const pruneHistory = async (second: number) => {
    await deps.history.prune(
      pruneBefore({
        second,
        retention: await deps.retention(),
        heldMinutes: minutes.pending().map((each) => each.minute),
      }),
    );
  };

  return {
    pass: () =>
      exclusive(async () => {
        const look = await trees.look();
        latest = totalsOf(look.components, look.rig).map(
          ({ series, sample }) => {
            minutes.record(series, storedSample(sample), look.second);
            return { series, sample, at: look.second };
          },
        );
        flushing = await maintained(FLUSH, flushing, look.at, writeChanged);
        pruning = await maintained(PRUNE, pruning, look.at, () =>
          pruneHistory(look.second),
        );
        if (flushing.failure !== undefined) throw flushing.failure;
        if (pruning.failure !== undefined) throw pruning.failure;
      }),
    snapshot() {
      return { latest, pending: minutes.pending() };
    },
    consistently: (read) =>
      exclusive(() => read({ latest, pending: minutes.pending() })),
    flush: () => exclusive(writeChanged),
    forget: (projectId) =>
      exclusive(async () => {
        const ofProject = (series: UsageSeries) =>
          "projectId" in series && series.projectId === projectId;
        minutes.drop(ofProject);
        latest = latest.filter((each) => !ofProject(each.series));
        trees.forget(projectId);
        await deps.history.forget(projectId);
      }),
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

import type { StoredSample, UsageHistograms } from "../domain/usage-minute";

/** What one series of usage history describes. Projects and Targets are named by identity, which survives a rename;
 * the names are the latest seen, for display. */
export type UsageSeries =
  | { readonly scope: "host" }
  | { readonly scope: "rig" }
  | ({ readonly scope: "project" } & ProjectRef)
  | ({ readonly scope: "target" } & TargetRef)
  | ({
      readonly scope: "component";
      readonly component: string;
      readonly componentKind: "service" | "job";
    } & TargetRef);

export interface ProjectRef {
  readonly projectId: string;
  readonly project: string;
}

export interface TargetRef extends ProjectRef {
  readonly targetId: string;
  /** `stable`, `working`, or the Preview's name. */
  readonly target: string;
  readonly targetKind: "working" | "stable" | "preview";
}

/** Pure: the identity of a series, the same whatever its names: one series per key in storage. */
export function seriesKey(series: UsageSeries): string {
  switch (series.scope) {
    case "host":
    case "rig":
      return series.scope;
    case "project":
      return `project:${series.projectId}`;
    case "target":
      return `target:${series.projectId}:${series.targetId}`;
    case "component":
      return `component:${series.projectId}:${series.targetId}:${series.componentKind}:${series.component}`;
  }
}

/** The samples of one series in one minute, one slot per second from `minute * 60`. */
export interface RecordedMinute {
  readonly series: UsageSeries;
  /** Unix minutes: Unix seconds divided by 60. */
  readonly minute: number;
  readonly slots: readonly (StoredSample | undefined)[];
}

/** One series' history over a range: per-second spans for detail reads, per-minute spans for history reads. */
export interface SeriesHistory {
  readonly series: UsageSeries;
  readonly spans: readonly {
    readonly at: number;
    readonly histograms: UsageHistograms;
  }[];
}

/** Which series a read wants. */
export type SeriesFilter =
  | { readonly kind: "host" }
  | { readonly kind: "project"; readonly projectId: string };

/** rigd's stored usage history (`<RIG_ROOT>/monitor/usage.sqlite`). Every 1-second sample is kept as detail, and every
 * minute as a histogram; retention removes each kind on its own schedule. */
export interface UsageHistory {
  /** Records minutes, merged slot by slot with what is stored for the same series and minute, so writing a minute again
   * as it fills, or after a restart part way through it, keeps every sample. Updates each series' names. */
  write(minutes: readonly RecordedMinute[]): Promise<void>;
  /** The series `filter` selects and their spans that start from `from` up to `to` (Unix seconds). `detail` reads the
   * 1-second samples, one span per second, and returns nothing older than detail retention; otherwise one span per
   * minute. The `host` filter selects the Host, Rig itself and every Project's total; the `project` filter selects that
   * Project's total, its Targets and their Components. */
  read(request: {
    readonly filter: SeriesFilter;
    readonly from: number;
    readonly to: number;
    readonly detail: boolean;
  }): Promise<readonly SeriesHistory[]>;
  /** Removes detail of minutes before `detailBefore` and history of minutes before `historyBefore` (Unix seconds), and
   * series left with neither. */
  prune(input: {
    readonly detailBefore: number;
    readonly historyBefore: number;
  }): Promise<void>;
  /** Removes all history of a Project, as `rig forget` does. */
  forget(projectId: string): Promise<void>;
  /** Closes the store once every call in progress has finished; a later call fails. */
  close(): Promise<void>;
}

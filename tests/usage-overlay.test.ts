import { describe, expect, test } from "bun:test";
import { histogramsOf, type StoredSample } from "../src/domain/usage-minute";
import type { RecordedSpan } from "../src/domain/usage-summary";
import type {
  RecordedMinute,
  SeriesHistory,
  UsageSeries,
} from "../src/runtime/usage-history";
import {
  heldIn,
  overlaid,
  secondsOf,
  summarizedSpans,
} from "../src/runtime/usage-overlay";

const MINUTE = 6000;
const START = MINUTE * 60;
const web: UsageSeries = {
  scope: "component",
  projectId: "p-fletcher",
  project: "fletcher",
  targetId: "t-stable",
  target: "stable",
  targetKind: "stable",
  component: "web",
  componentKind: "service",
};
const project: UsageSeries = {
  scope: "project",
  projectId: "p-fletcher",
  project: "fletcher",
};

const sample = (cpu: number): StoredSample => ({ cpu, memory: 1 });
const histograms = (...cpu: number[]) => histogramsOf(cpu.map(sample))!;
const span = (at: number, ...cpu: number[]): RecordedSpan => ({
  at,
  histograms: histograms(...cpu),
});
/** A minute holding `cpu` at the given seconds. */
const held = (
  series: UsageSeries,
  minute: number,
  cpuBySecond: Record<number, number>,
): RecordedMinute => ({
  series,
  minute,
  slots: Array.from({ length: 60 }, (_, second) =>
    second in cpuBySecond ? sample(cpuBySecond[second]!) : undefined,
  ),
});
const stored = (
  series: UsageSeries,
  spans: readonly RecordedSpan[],
): SeriesHistory => ({ series, spans });
/** Each span as its start and its CPU values' sum and count, for comparing. */
const shape = (spans: readonly RecordedSpan[] | undefined) =>
  (spans ?? [])
    .map((each) => ({
      at: each.at,
      sum: each.histograms.cpu.sum,
      count: each.histograms.cpu.count,
    }))
    .sort((a, b) => a.at - b.at);

describe("held minutes in a range", () => {
  test("a minute is in a range when any of its seconds is, and the range's end is exclusive", () => {
    const minutes = [MINUTE - 1, MINUTE, MINUTE + 1].map((minute) =>
      held(web, minute, { 0: 1 }),
    );
    expect(
      heldIn(minutes, { from: START - 1, to: START + 60 }).map(
        (each) => each.minute,
      ),
    ).toEqual([MINUTE - 1, MINUTE]);
    expect(
      heldIn(minutes, { from: START, to: START + 61 }).map(
        (each) => each.minute,
      ),
    ).toEqual([MINUTE, MINUTE + 1]);
    expect(heldIn(minutes, { from: START + 60, to: START + 60 })).toEqual([]);
  });
});

describe("a held minute's seconds", () => {
  test("are the seconds it holds, with the stored ones where it holds none", () => {
    const storedSeconds = new Map([
      [START + 1, histograms(500)],
      [START + 2, histograms(600)],
    ]);
    expect(
      shape(secondsOf(held(web, MINUTE, { 0: 10, 2: 20 }), storedSeconds)),
    ).toEqual([
      { at: START, sum: 10, count: 1 },
      { at: START + 1, sum: 500, count: 1 },
      { at: START + 2, sum: 20, count: 1 },
    ]);
  });

  test("are only those it holds when nothing is stored, and none for an empty minute", () => {
    expect(shape(secondsOf(held(web, MINUTE, { 59: 7 })))).toEqual([
      { at: START + 59, sum: 7, count: 1 },
    ]);
    expect(secondsOf(held(web, MINUTE, {}), new Map())).toEqual([]);
  });
});

describe("held minutes laid over stored history", () => {
  test("by the second, a held second replaces the stored one and the stored seconds it does not hold stay", () => {
    const entries = overlaid({
      resolution: "second",
      stored: [stored(web, [span(START, 500), span(START + 1, 600)])],
      held: [held(web, MINUTE, { 1: 10, 2: 20 })],
    });
    expect(
      shape(entries.get("component:p-fletcher:t-stable:service:web")?.spans),
    ).toEqual([
      { at: START, sum: 500, count: 1 },
      { at: START + 1, sum: 10, count: 1 },
      { at: START + 2, sum: 20, count: 1 },
    ]);
  });

  test("by the minute, a held minute partly stored merges its seconds with the stored ones it does not hold", () => {
    const entries = overlaid({
      resolution: "minute",
      stored: [stored(web, [span(START - 60, 1, 1), span(START, 500, 600)])],
      storedSeconds: [stored(web, [span(START, 500), span(START + 1, 600)])],
      held: [held(web, MINUTE, { 1: 10, 2: 20 })],
    });
    expect(
      shape(entries.get("component:p-fletcher:t-stable:service:web")?.spans),
    ).toEqual([
      { at: START - 60, sum: 2, count: 2 },
      { at: START, sum: 530, count: 3 },
    ]);
  });

  test("by the minute, a held minute whose stored seconds are pruned is built from what it holds alone", () => {
    const entries = overlaid({
      resolution: "minute",
      stored: [stored(web, [span(START, 500, 600)])],
      storedSeconds: [],
      held: [held(web, MINUTE, { 1: 10, 2: 20 })],
    });
    expect(
      shape(entries.get("component:p-fletcher:t-stable:service:web")?.spans),
    ).toEqual([{ at: START, sum: 30, count: 2 }]);
  });

  test("by the minute, a held minute with no seconds at all leaves the stored minute", () => {
    const entries = overlaid({
      resolution: "minute",
      stored: [stored(web, [span(START, 500, 600)])],
      storedSeconds: [],
      held: [held(web, MINUTE, {})],
    });
    expect(
      shape(entries.get("component:p-fletcher:t-stable:service:web")?.spans),
    ).toEqual([{ at: START, sum: 1100, count: 2 }]);
  });

  test("a held minute repeated for a series counts as its last copy", () => {
    const repeated = [
      held(web, MINUTE, { 0: 10 }),
      held(web, MINUTE, { 0: 30, 1: 40 }),
    ];
    const bySecond = overlaid({
      resolution: "second",
      stored: [],
      held: repeated,
    });
    expect(
      shape(bySecond.get("component:p-fletcher:t-stable:service:web")?.spans),
    ).toEqual([
      { at: START, sum: 30, count: 1 },
      { at: START + 1, sum: 40, count: 1 },
    ]);
    const byMinute = overlaid({
      resolution: "minute",
      stored: [],
      storedSeconds: [],
      held: repeated,
    });
    expect(
      shape(byMinute.get("component:p-fletcher:t-stable:service:web")?.spans),
    ).toEqual([{ at: START, sum: 70, count: 2 }]);
  });

  test("a series only held follows the stored ones, under its first held minute's names, and stored series keep theirs", () => {
    const renamed = { ...project, project: "fletcher-2" } as const;
    const entries = overlaid({
      resolution: "second",
      stored: [stored(web, [span(START, 500)])],
      held: [
        held(project, MINUTE, { 0: 1 }),
        held(renamed, MINUTE + 1, { 0: 2 }),
      ],
    });
    expect([...entries.keys()]).toEqual([
      "component:p-fletcher:t-stable:service:web",
      "project:p-fletcher",
    ]);
    expect(entries.get("project:p-fletcher")?.series).toEqual(project);
    expect(shape(entries.get("project:p-fletcher")?.spans)).toEqual([
      { at: START, sum: 1, count: 1 },
      { at: START + 60, sum: 2, count: 1 },
    ]);
    expect(
      entries.get("component:p-fletcher:t-stable:service:web")?.series,
    ).toEqual(web);
  });

  test("nothing held leaves the stored spans as they are", () => {
    const spans = [span(START, 500), span(START + 60, 600)];
    const entries = overlaid({
      resolution: "minute",
      stored: [stored(web, spans)],
      storedSeconds: [],
      held: [],
    });
    expect(entries.get("component:p-fletcher:t-stable:service:web")).toEqual({
      series: web,
      spans,
    });
  });
});

describe("the spans a summary counts", () => {
  const minutes = [span(START - 60, 1), span(START, 2), span(START + 60, 3)];

  test("with no boundary minute, or none with seconds, are the spans themselves", () => {
    expect(summarizedSpans(minutes, [])).toBe(minutes);
    expect(summarizedSpans(minutes, [{ start: START, seconds: [] }])).toBe(
      minutes,
    );
  });

  test("replace each boundary minute that has seconds by them, and count one whose seconds are pruned whole", () => {
    const seconds = [span(START + 59, 9)];
    expect(
      shape(
        summarizedSpans(minutes, [
          { start: START - 60, seconds: [] },
          { start: START, seconds },
        ]),
      ),
    ).toEqual([
      { at: START - 60, sum: 1, count: 1 },
      { at: START + 59, sum: 9, count: 1 },
      { at: START + 60, sum: 3, count: 1 },
    ]);
  });

  test("replace both boundary minutes when both have seconds", () => {
    expect(
      shape(
        summarizedSpans(minutes, [
          { start: START - 60, seconds: [span(START - 1, 7)] },
          { start: START + 60, seconds: [span(START + 60, 8)] },
        ]),
      ),
    ).toEqual([
      { at: START - 1, sum: 7, count: 1 },
      { at: START, sum: 2, count: 1 },
      { at: START + 60, sum: 8, count: 1 },
    ]);
  });
});

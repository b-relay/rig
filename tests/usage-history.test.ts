import { describe, expect, test } from "bun:test";
import {
  decodeHistogram,
  encodeHistogram,
  histogramOf,
  mergeHistograms,
  quantileOf,
} from "../src/domain/usage-histogram";
import {
  decodeMinute,
  encodeMinute,
  histogramsOf,
  storedSample,
} from "../src/domain/usage-minute";
import {
  cpuByProcess,
  sumSamples,
  treeUsage,
} from "../src/domain/usage-sample";
import { chartOf, stepFor, summaryOf } from "../src/domain/usage-summary";

const SECOND = 1e9;

describe("treeUsage", () => {
  const reading = (
    pid: number,
    cpuSeconds: number,
    memoryBytes = 1,
    started = 1,
  ) => ({
    pid,
    started,
    cpuNs: cpuSeconds * SECOND,
    memoryBytes,
  });

  test("CPU is the CPU time the tree gained over the wall time, 100% per busy core", () => {
    const usage = treeUsage({
      previous: cpuByProcess([reading(10, 4), reading(11, 1)]),
      current: [reading(10, 5.5, 300), reading(11, 2, 200)],
      elapsedNs: SECOND,
      cores: 8,
    });
    expect(usage).toEqual({ cpuPercent: 250, memoryBytes: 500 });
  });

  test("a child that started during the interval counts all of its CPU time; one that ended counts none", () => {
    const usage = treeUsage({
      previous: cpuByProcess([reading(10, 1), reading(12, 9)]),
      current: [reading(10, 1.2), reading(13, 0.3)],
      elapsedNs: SECOND,
      cores: 8,
    });
    expect(usage.cpuPercent).toBeCloseTo(50);
  });

  test("the first sight of a tree has memory but no CPU, since there is nothing to measure CPU from", () => {
    expect(
      treeUsage({
        previous: undefined,
        current: [reading(10, 50, 7)],
        elapsedNs: SECOND,
        cores: 8,
      }),
    ).toEqual({ cpuPercent: undefined, memoryBytes: 7 });
  });

  test("a long-lived process the previous reading missed cannot push CPU past every core busy", () => {
    const usage = treeUsage({
      previous: cpuByProcess([reading(10, 0)]),
      current: [reading(99, 3600)],
      elapsedNs: SECOND,
      cores: 4,
    });
    expect(usage.cpuPercent).toBe(400);
  });

  test("a pid another process reuses is a new process, whether its CPU time is lower or higher than the old one's", () => {
    // The first process used 0.1 s and exited; another got its pid and has used 0.5 s by the next reading.
    const higher = treeUsage({
      previous: cpuByProcess([reading(10, 0.1, 1, 100)]),
      current: [reading(10, 0.5, 1, 200)],
      elapsedNs: SECOND,
      cores: 4,
    });
    expect(higher.cpuPercent).toBeCloseTo(50);
    const lower = treeUsage({
      previous: cpuByProcess([reading(10, 90, 1, 100)]),
      current: [reading(10, 0.1, 1, 200)],
      elapsedNs: SECOND,
      cores: 4,
    });
    expect(lower.cpuPercent).toBeCloseTo(10);
  });
});

test("samples taken at one moment add up, and none add up to nothing rather than to zero", () => {
  expect(
    sumSamples([
      { cpuPercent: 12.5, memoryBytes: 100 },
      { cpuPercent: 80, memoryBytes: 50 },
    ]),
  ).toEqual({ cpuPercent: 92.5, memoryBytes: 150 });
  expect(sumSamples([])).toBeUndefined();
});

describe("usage histograms", () => {
  const values = Array.from({ length: 1000 }, (_, i) => i + 1);

  test("low and high are exact, and the median and p95 are within 5% of the true values", () => {
    const histogram = histogramOf(values)!;
    expect(histogram.low).toBe(1);
    expect(histogram.high).toBe(1000);
    expect(histogram.sum / histogram.count).toBe(500.5);
    expect(Math.abs(quantileOf(histogram, 0.5) / 500 - 1)).toBeLessThan(0.05);
    expect(Math.abs(quantileOf(histogram, 0.95) / 950 - 1)).toBeLessThan(0.05);
  });

  test("merged histograms give the median of all their values together, which medians of the parts cannot", () => {
    // One quiet minute and one busy one: the median of the two minutes' medians (5 and 400) is neither minute's value.
    const quiet = histogramOf(Array(50).fill(5))!;
    const busy = histogramOf(Array(10).fill(400))!;
    const both = mergeHistograms([quiet, undefined, busy])!;
    expect(both).toEqual(
      histogramOf([...Array(50).fill(5), ...Array(10).fill(400)])!,
    );
    expect(quantileOf(both, 0.5)).toBe(5);
    expect(quantileOf(both, 0.95)).toBe(400);
  });

  test("no values make no histogram, so an idle span is not mistaken for zero use", () => {
    expect(histogramOf([])).toBeUndefined();
    expect(mergeHistograms([undefined])).toBeUndefined();
  });

  test("a histogram survives storage unchanged, and damaged bytes are refused", () => {
    const histogram = histogramOf([0, 3, 3, 70_000, 2 ** 31])!;
    expect(decodeHistogram(encodeHistogram(histogram))).toEqual(histogram);
    expect(
      decodeHistogram(encodeHistogram(histogram).slice(0, 10)),
    ).toBeUndefined();
    expect(decodeHistogram(new Uint8Array(30))).toBeUndefined();
  });
});

describe("stored minutes", () => {
  test("a minute of samples survives storage, with the seconds that have no sample still empty", () => {
    const slots = Array.from({ length: 60 }, (_, second) =>
      second % 7 === 0
        ? undefined
        : { cpu: second * 10, memory: 4096 + second },
    );
    expect(decodeMinute(encodeMinute(slots))).toEqual(slots);
  });

  test("samples are stored as tenths of a percent and KiB, and absurd values are kept within a slot", () => {
    expect(
      storedSample({ cpuPercent: 142.34, memoryBytes: 3 * 1024 ** 3 }),
    ).toEqual({
      cpu: 1423,
      memory: 3 * 1024 ** 2,
    });
    expect(storedSample({ cpuPercent: -1, memoryBytes: 1e18 })).toEqual({
      cpu: 0,
      memory: 0xffffffff - 1,
    });
  });

  test("a damaged minute reads as one with no samples", () => {
    expect(
      decodeMinute(new Uint8Array(5)).every((slot) => slot === undefined),
    ).toBe(true);
  });
});

describe("chart points", () => {
  test("the step keeps a chart to at most 360 points: 15 s for an hour, 5 minutes for a day, 30 minutes for a week", () => {
    expect(stepFor(3600)).toBe(15);
    expect(stepFor(86_400)).toBe(300);
    expect(stepFor(7 * 86_400)).toBe(1800);
  });

  test("spans are grouped into steps, a step with no samples is a gap, and spans outside the range are ignored", () => {
    const minute = (at: number, cpu: number) => ({
      at,
      histograms: histogramsOf([{ cpu, memory: 1024 }])!,
    });
    const { points, summary } = chartOf({
      from: 600,
      to: 900,
      step: 120,
      spans: [
        minute(540, 1),
        minute(600, 100),
        minute(660, 300),
        minute(840, 50),
        minute(900, 9),
      ],
    });
    expect(summary.cpu).toMatchObject({ low: 5, high: 30 });
    expect(points.map((point) => point.at)).toEqual([600, 720, 840]);
    expect(points[0]!.cpu).toMatchObject({ low: 10, high: 30, average: 20 });
    expect(points[0]!.memory).toMatchObject({
      low: 1024 * 1024,
      high: 1024 * 1024,
    });
    expect(points[1]).toEqual({ at: 720 });
    expect(points[2]!.cpu).toMatchObject({ low: 5, high: 5, median: 5 });
  });

  test("a summary of nothing has neither measure", () => {
    expect(summaryOf([])).toEqual({});
  });
});

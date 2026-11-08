import { expect, test } from "bun:test";
import { RigError } from "../domain/errors";
import type { MonitorResult, RuntimeCommand } from "../daemon/protocol";
import { watchMonitor } from "./monitor-watch";
import { cliHarness } from "../../tests/support/cli-harness";

const request: RuntimeCommand = {
  action: "monitor",
  repoPath: "/workspace",
  operationId: "op-1",
};
/** A Project's report whose CPU now reads `cpu`, sampled every `every` seconds. */
const sample = (cpu: number, every = 2): MonitorResult => ({
  project: "fletcher",
  since: 0,
  from: 0,
  to: 3600,
  step: 15,
  sampledEvery: every,
  series: [
    {
      series: { scope: "project", projectId: "p1", project: "fletcher" },
      now: { cpuPercent: cpu, memoryBytes: 1e9 },
      summary: {
        cpu: { low: 0, high: 9, average: 5, median: 5, p95: 9 },
        memory: { low: 0, high: 2e9, average: 1e9, median: 1e9, p95: 2e9 },
      },
      points: [],
    },
  ],
});
const T0 = Date.UTC(2026, 9, 12, 10, 0, 0);

/** A watch whose clock moves with each wait and whose Ctrl-C comes at wait `stopAt`. */
function watch(stopAt: number, reply: (count: number) => unknown) {
  let clock = T0;
  const stop = new AbortController();
  const delays: number[] = [];
  const cli = cliHarness({
    signal: stop.signal,
    now: () => new Date(clock),
    wait: async (ms) => {
      delays.push(ms);
      clock += ms;
      if (delays.length === stopAt) stop.abort();
    },
    command: () => reply(cli.requests.length),
  });
  return {
    cli,
    delays,
    deps: { ...cli.deps, outputTerminal: () => ({ columns: 80, rows: 24 }) },
  };
}

test("a watch redraws on the alternate screen after every sample, waiting the sample interval, and leaves the last table on the main screen", async () => {
  const { cli, delays, deps } = watch(3, (count) => sample(10 + count));
  await watchMonitor(request, sample(10), undefined, deps);
  expect(delays).toEqual([2000, 2000, 2000]);
  expect(cli.requests).toEqual([request, request]);
  const frames = cli.out().split("\x1b[H\x1b[J");
  expect(frames[0]).toBe("\x1b[?1049h");
  expect(frames).toHaveLength(4);
  expect(frames[1]).toContain("10%");
  expect(frames[3]).toContain("12%");
  const left = frames[3]!.split("\x1b[?1049l")[1]!;
  expect(left).toContain("12%");
  expect(left).toContain(
    `Updated ${new Date(T0 + 4000).toLocaleTimeString()} · Ctrl-C to stop\n`,
  );
  expect(cli.err()).toBe("");
});

test("a watch over a duration resolves it again against the clock at every refresh; an ISO time stays where it was", async () => {
  const { cli, deps } = watch(3, () => sample(1, 5));
  await watchMonitor(
    request,
    sample(1, 5),
    { since: "1h", until: "2026-10-12T10:30:00Z" },
    deps,
  );
  expect(cli.requests.map((sent) => sent.window)).toEqual([
    {
      since: new Date(T0 + 5000 - 3_600_000).toISOString(),
      until: "2026-10-12T10:30:00.000Z",
    },
    {
      since: new Date(T0 + 10_000 - 3_600_000).toISOString(),
      until: "2026-10-12T10:30:00.000Z",
    },
  ]);
});

test("a read rigd fails ends the watch with that failure, after the screen is restored", async () => {
  const failure = new RigError("UNREACHABLE", "rigd went away.", "Run rigd.");
  const { cli, deps } = watch(5, () => {
    throw failure;
  });
  expect(
    await watchMonitor(request, sample(1), undefined, deps).catch((e) => e),
  ).toBe(failure);
  expect(cli.out()).toContain("\x1b[?1049l");
});

test("a read Ctrl-C abandoned ends the watch quietly", async () => {
  const stop = new AbortController();
  const cli = cliHarness({
    signal: stop.signal,
    command: () => {
      stop.abort();
      throw new RigError("CANCELLED", "The read was cancelled.", "Retry.");
    },
  });
  await watchMonitor(request, sample(1), undefined, {
    ...cli.deps,
    outputTerminal: () => ({ columns: 80, rows: 24 }),
  });
  expect(cli.requests).toHaveLength(1);
  expect(cli.out()).toContain("\x1b[?1049l");
});

import { expect, test } from "bun:test";
import type { MonitorResult, RuntimeCommand } from "../src/daemon/protocol";
import { runRigCli } from "../src/cli/rig";
import { monitorLines } from "../src/cli/monitor-output";

const stats = (median: number, high: number) => ({
  low: 0,
  high,
  average: median,
  median,
  p95: high,
});
const stable = {
  projectId: "p1",
  project: "fletcher",
  targetId: "t1",
  target: "stable",
  targetKind: "stable" as const,
};
const projectReport: MonitorResult = {
  project: "fletcher",
  range: "1h",
  from: 0,
  to: 3600,
  step: 15,
  sampledEvery: 1,
  series: [
    {
      series: { scope: "project", projectId: "p1", project: "fletcher" },
      now: { cpuPercent: 96.2, memoryBytes: 1.5e9 },
      summary: { cpu: stats(43, 297), memory: stats(1.5e9, 2.8e9) },
      points: [],
    },
    {
      series: { scope: "target", ...stable },
      now: { cpuPercent: 96.2, memoryBytes: 1.5e9 },
      summary: { cpu: stats(43, 297), memory: stats(1.5e9, 2.8e9) },
      points: [],
    },
    {
      series: {
        scope: "component",
        ...stable,
        component: "web",
        componentKind: "service",
      },
      now: { cpuPercent: 3.42, memoryBytes: 410e6 },
      summary: { cpu: stats(9, 57), memory: stats(414e6, 435e6) },
      points: [],
    },
    {
      series: {
        scope: "component",
        ...stable,
        component: "crawl",
        componentKind: "job",
      },
      summary: { cpu: stats(93, 102), memory: stats(614e6, 658e6) },
      points: [],
    },
  ],
};

function harness(
  reply: (request: RuntimeCommand) => unknown,
  terminal = false,
) {
  const requests: RuntimeCommand[] = [];
  let out = "";
  let err = "";
  const stop = new AbortController();
  let waits = 0;
  const deps = {
    root: "/isolated/.rig",
    cwd: "/workspace/fletcher",
    client: {
      async status(): Promise<never> {
        throw new Error("not used");
      },
      async command(request: RuntimeCommand) {
        requests.push(request);
        return reply(request);
      },
    },
    output: {
      write: (value: string) => void (out += value),
      error: (value: string) => void (err += value),
    },
    diagnostics: {
      async record() {
        return { path: "/isolated/log" };
      },
    },
    newOperationId: () => "op-1",
    signal: stop.signal,
    /** Two redraws, then Ctrl-C. */
    wait: async () => {
      if (++waits === 2) stop.abort();
    },
    now: () => new Date(Date.UTC(2026, 9, 12, 10, 0, 0)),
    outputTerminal: terminal,
    terminalColumns: 120,
  };
  return { deps, requests, out: () => out, err: () => err };
}

test("the table shows each Target's total with its Services and Jobs under it, now, median and peak, and – where nothing runs", () => {
  expect(monitorLines(projectReport)).toEqual([
    "fletcher · the last hour · sampled every 1 s",
    "",
    "                CPU  median  peak  Memory  median    peak",
    "all Targets     96%     43%  297%  1.5 GB  1.5 GB  2.8 GB",
    "stable          96%     43%  297%  1.5 GB  1.5 GB  2.8 GB",
    "  web          3.4%    9.0%   57%  410 MB  414 MB  435 MB",
    "  crawl (job)     –     93%  102%       –  614 MB  658 MB",
  ]);
});

test("with nothing sampled, the table says so instead of showing an empty grid", () => {
  expect(monitorLines({ ...projectReport, range: "7d", series: [] })[1]).toBe(
    "No CPU or memory was sampled in the last 7 days: nothing ran, or rigd only just started sampling.",
  );
});

test("rig monitor asks for the Project in the current directory, and --all for the whole Host, over the range given", async () => {
  const h = harness(() => projectReport);
  expect(await runRigCli(["monitor"], h.deps)).toBe(0);
  expect(await runRigCli(["monitor", "--all", "--range", "24h"], h.deps)).toBe(
    0,
  );
  expect(
    await runRigCli(
      ["monitor", "--project", "fletcher", "--range", "7d"],
      h.deps,
    ),
  ).toBe(0);
  expect(h.requests.map(({ operationId: _id, ...request }) => request)).toEqual(
    [
      { action: "monitor", range: "1h", repoPath: "/workspace/fletcher" },
      { action: "monitor", range: "24h", host: true },
      {
        action: "monitor",
        range: "7d",
        repoPath: "/workspace/fletcher",
        project: "fletcher",
      },
    ],
  );
});

test("--all with --project, or a range rig does not keep, is refused before rigd is asked", async () => {
  const h = harness(() => projectReport);
  expect(
    await runRigCli(["monitor", "--all", "--project", "fletcher"], h.deps),
  ).toBe(1);
  expect(h.err()).toContain("--all covers every Project");
  expect(await runRigCli(["monitor", "--range", "30d"], h.deps)).toBe(1);
  expect(h.requests).toEqual([]);
});

test("piped, the table is printed once; on a terminal it is redrawn in place every sample until Ctrl-C", async () => {
  const piped = harness(() => projectReport);
  expect(await runRigCli(["monitor"], piped.deps)).toBe(0);
  expect(piped.requests.length).toBe(1);
  expect(piped.out()).toBe(`${monitorLines(projectReport).join("\n")}\n`);

  let cpu = 96.2;
  const live = harness(() => {
    cpu += 10;
    return {
      ...projectReport,
      series: projectReport.series.map((each) => ({
        ...each,
        ...(each.now && { now: { ...each.now, cpuPercent: cpu } }),
      })),
    };
  }, true);
  expect(await runRigCli(["monitor"], live.deps)).toBe(0);
  expect(live.requests.length).toBe(2);
  // The second draw moves up over the first (9 lines) before writing.
  expect(live.out()).toContain("\x1b[9A\r\x1b[J");
  expect(live.out()).toContain("116%");
  expect(live.out()).toContain("Ctrl-C to stop");
});

test("--json prints the report once, even on a terminal", async () => {
  const h = harness(() => projectReport, true);
  expect(await runRigCli(["monitor", "--json"], h.deps)).toBe(0);
  expect(JSON.parse(h.out())).toEqual(projectReport);
  expect(h.requests.length).toBe(1);
});

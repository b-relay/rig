import { expect, test } from "bun:test";
import type { MonitorResult, RuntimeCommand } from "../src/daemon/protocol";
import { RigError } from "../src/domain/errors";
import type { TerminalSize } from "../src/cli/live-region";
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
const working = {
  ...stable,
  targetId: "t2",
  target: "working",
  targetKind: "working" as const,
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
      series: { scope: "target", ...working },
      summary: { cpu: stats(2, 5), memory: stats(2e8, 3e8) },
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
        ...working,
        component: "web",
        componentKind: "service",
      },
      summary: { cpu: stats(2, 5), memory: stats(2e8, 3e8) },
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

/** A screen that understands what the live region writes: moving up and clearing to the end, and clearing it all. */
function screen() {
  let lines: string[] = [];
  let cursor = 0;
  return {
    write(text: string) {
      let rest = text;
      while (rest.length) {
        const up = /^\x1b\[(\d+)A\r\x1b\[J/.exec(rest);
        const clear = /^\x1b\[H\x1b\[2J/.exec(rest);
        if (up) {
          cursor = Math.max(0, cursor - Number(up[1]));
          lines = lines.slice(0, cursor);
          rest = rest.slice(up[0].length);
        } else if (clear) {
          lines = [];
          cursor = 0;
          rest = rest.slice(clear[0].length);
        } else {
          const end = rest.indexOf("\n");
          lines[cursor++] = rest.slice(0, end);
          rest = rest.slice(end + 1);
        }
      }
    },
    lines: () => lines,
  };
}

function harness(
  reply: (request: RuntimeCommand, count: number) => unknown,
  terminal?: TerminalSize,
) {
  const requests: RuntimeCommand[] = [];
  const shown = screen();
  let out = "";
  let err = "";
  const stop = new AbortController();
  let waits = 0;
  const size = { ...terminal };
  const deps = {
    root: "/isolated/.rig",
    cwd: "/workspace/fletcher",
    client: {
      async status(): Promise<never> {
        throw new Error("not used");
      },
      async command(request: RuntimeCommand) {
        requests.push(request);
        return reply(request, requests.length);
      },
    },
    output: {
      write: (value: string) => {
        out += value;
        shown.write(value);
      },
      error: (value: string) => void (err += value),
    },
    diagnostics: {
      async record() {
        return { path: "/isolated/log" };
      },
    },
    newOperationId: () => "op-1",
    signal: stop.signal,
    /** Three redraws, then Ctrl-C. */
    wait: async () => {
      if (++waits === 3) stop.abort();
    },
    now: () => new Date(Date.UTC(2026, 9, 12, 10, 0, 0)),
    ...(terminal
      ? { outputTerminal: () => size as TerminalSize, terminalColumns: 80 }
      : {}),
  };
  return {
    deps,
    requests,
    size,
    out: () => out,
    err: () => err,
    screen: shown.lines,
  };
}

test("the table shows each Target's total with its own Services and Jobs under it, now, median and peak, and – where nothing runs", () => {
  expect(monitorLines(projectReport)).toEqual([
    "fletcher · the last hour · sampled every 1 s",
    "",
    "                CPU  median  peak  Memory  median    peak",
    "all Targets     96%     43%  297%  1.5 GB  1.5 GB  2.8 GB",
    "stable          96%     43%  297%  1.5 GB  1.5 GB  2.8 GB",
    "  web          3.4%    9.0%   57%  410 MB  414 MB  435 MB",
    "  crawl (job)     –     93%  102%       –  614 MB  658 MB",
    "working           –    2.0%  5.0%       –  200 MB  300 MB",
    "  web             –    2.0%  5.0%       –  200 MB  300 MB",
  ]);
});

test("on a narrow terminal a long name is cut, not the numbers", () => {
  const long = "a-very-long-service-name-that-would-push-the-numbers-off";
  const lines = monitorLines(
    {
      ...projectReport,
      series: projectReport.series.map((each) =>
        each.series.component === "web" && each.series.target === "stable"
          ? { ...each, series: { ...each.series, component: long } }
          : each,
      ),
    },
    72,
  );
  for (const line of lines.slice(2))
    expect(line.length).toBeLessThanOrEqual(72);
  expect(lines.find((line) => line.startsWith("  a-very"))).toContain("435 MB");
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

test("--all with --project, or a range rig does not keep, is refused before rigd is asked, as JSON with --json", async () => {
  const h = harness(() => projectReport);
  expect(
    await runRigCli(["monitor", "--all", "--project", "fletcher"], h.deps),
  ).toBe(1);
  expect(h.err()).toContain("--all covers every Project");
  expect(await runRigCli(["monitor", "--range", "30d"], h.deps)).toBe(1);
  const json = harness(() => projectReport);
  expect(
    await runRigCli(
      ["monitor", "--json", "--all", "--project", "fletcher"],
      json.deps,
    ),
  ).toBe(1);
  expect(JSON.parse(json.out()).error.code).toBe("USAGE");
  expect(h.requests).toEqual([]);
  expect(json.requests).toEqual([]);
});

test("rig monitor -h and --help describe the command and its flags", async () => {
  for (const flag of ["-h", "--help"]) {
    const h = harness(() => projectReport);
    expect(await runRigCli(["monitor", flag], h.deps)).toBe(0);
    expect(h.out()).toContain("--range <span>");
    expect(h.out()).toContain("--all");
  }
});

test("piped, the table is printed once; on a terminal it is redrawn in place every sample until Ctrl-C", async () => {
  const piped = harness(() => projectReport);
  expect(await runRigCli(["monitor"], piped.deps)).toBe(0);
  expect(piped.requests.length).toBe(1);
  expect(piped.out()).toBe(`${monitorLines(projectReport).join("\n")}\n`);

  const live = harness(
    (_request, count) => ({
      ...projectReport,
      series: projectReport.series.map((each) =>
        each.now
          ? { ...each, now: { ...each.now, cpuPercent: 100 + count } }
          : each,
      ),
    }),
    { columns: 100, rows: 40 },
  );
  expect(await runRigCli(["monitor"], live.deps)).toBe(0);
  expect(live.requests.length).toBe(3);
  // The screen holds one table, the newest, and nothing left over from the earlier draws.
  expect(live.screen()).toEqual([
    ...monitorLines(
      {
        ...projectReport,
        series: projectReport.series.map((each) =>
          each.now ? { ...each, now: { ...each.now, cpuPercent: 103 } } : each,
        ),
      },
      100,
    ),
    "",
    expect.stringContaining("Ctrl-C to stop"),
  ]);
});

test("a table taller than the terminal keeps its first rows and says how many it left out", async () => {
  const h = harness(() => projectReport, { columns: 100, rows: 6 });
  await runRigCli(["monitor"], h.deps);
  expect(h.screen().length).toBe(5);
  expect(h.screen().at(-1)).toMatch(/^… \d+ more rows/);
});

test("after the terminal is resized the screen is cleared and the table drawn again to the new width", async () => {
  let resize: (() => void) | undefined;
  const h = harness(
    (_request, count) => {
      if (count === 2) resize?.();
      return projectReport;
    },
    { columns: 100, rows: 40 },
  );
  resize = () => {
    h.size.columns = 50;
  };
  await runRigCli(["monitor"], h.deps);
  expect(h.out()).toContain("\x1b[H\x1b[2J");
  for (const line of h.screen()) expect(Bun.stringWidth(line)).toBeLessThan(50);
});

test("a read that fails while watching ends the watch with that failure", async () => {
  const h = harness(
    (_request, count) => {
      if (count === 2)
        throw new RigError(
          "DAEMON_UNREACHABLE",
          "rigd is not answering.",
          "Run rigd status.",
        );
      return projectReport;
    },
    { columns: 100, rows: 40 },
  );
  expect(await runRigCli(["monitor"], h.deps)).toBe(1);
  expect(h.err()).toContain("rigd is not answering.");
});

test("--json prints the report once, even on a terminal", async () => {
  const h = harness(() => projectReport, { columns: 100, rows: 40 });
  expect(await runRigCli(["monitor", "--json"], h.deps)).toBe(0);
  expect(JSON.parse(h.out())).toEqual(projectReport);
  expect(h.requests.length).toBe(1);
});

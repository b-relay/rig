import { expect, test } from "bun:test";
import type { MonitorResult, RuntimeCommand } from "../src/daemon/protocol";
import { RigError } from "../src/domain/errors";
import { fitted, type TerminalSize } from "../src/cli/live-region";
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
  since: 0,
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

/** A terminal that understands what the CLI writes: the alternate screen, cursor home, up and return, and erasing to
 * the end of the screen or all of it, on whichever screen is showing. Text wraps at the width and scrolls past the last
 * row, so a test sees what a person would; any other control sequence fails the test. The main screen starts with
 * earlier output, which nothing should disturb. */
function screenOf(size: { columns?: number; rows?: number }) {
  type Screen = { rows: string[]; row: number; column: number };
  const main: Screen = { rows: ["$ earlier output", ""], row: 1, column: 0 };
  let alternate: Screen | undefined;
  let wrapped = false;
  let scrolled = false;
  const showing = () => alternate ?? main;
  const put = (text: string) => {
    const screen = showing();
    for (const character of text) {
      if (character === "\n") {
        screen.row++;
        screen.column = 0;
        screen.rows[screen.row] ??= "";
      } else if (character === "\r") screen.column = 0;
      else {
        screen.rows[screen.row] += character;
        screen.column += Bun.stringWidth(character);
        if (size.columns !== undefined && screen.column > size.columns)
          wrapped = true;
      }
    }
    if (alternate && alternate.rows.length > (size.rows ?? Infinity))
      scrolled = true;
  };
  const control = (sequence: string) => {
    const screen = showing();
    if (sequence === "\x1b[?1049h")
      alternate = { rows: [""], row: 0, column: 0 };
    else if (sequence === "\x1b[?1049l") alternate = undefined;
    else if (sequence === "\x1b[H")
      Object.assign(screen, { row: 0, column: 0 });
    else if (sequence === "\x1b[J")
      screen.rows = [
        ...screen.rows.slice(0, screen.row),
        screen.rows[screen.row]!.slice(0, screen.column),
      ];
    else if (sequence === "\x1b[2J") screen.rows = screen.rows.map(() => "");
    else if (/^\x1b\[\d+A$/.test(sequence))
      screen.row = Math.max(0, screen.row - Number(sequence.slice(2, -1)));
    else
      throw new Error(
        `unexpected control sequence ${JSON.stringify(sequence)}`,
      );
  };
  return {
    write(text: string) {
      for (const part of text.split(/(\x1b\[[0-9;?]*[A-Za-z])/))
        if (part.startsWith("\x1b")) control(part);
        else if (part) put(part);
    },
    /** The rows of the screen showing now, without the empty row the cursor waits on. */
    lines: () => {
      const { rows } = showing();
      return rows.at(-1) === "" ? rows.slice(0, -1) : rows;
    },
    alternate: () => alternate !== undefined,
    wrapped: () => wrapped,
    scrolled: () => scrolled,
  };
}

function harness(
  reply: (request: RuntimeCommand, count: number) => unknown,
  terminal?: Partial<TerminalSize>,
) {
  const requests: RuntimeCommand[] = [];
  const size = { ...terminal };
  const shown = screenOf(size);
  let out = "";
  let err = "";
  const stop = new AbortController();
  let waits = 0;
  const delays: number[] = [];
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
    /** Three redraws a second apart, then Ctrl-C. */
    wait: async (ms: number) => {
      delays.push(ms);
      if (++waits === 3) stop.abort();
    },
    now: () => new Date(Date.UTC(2026, 9, 12, 10, 0, waits)),
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
    screen: shown,
    delays,
  };
}

test("the table shows each Target's total with its own Services and Jobs under it, now, median and peak, and – where nothing runs", () => {
  expect(monitorLines(projectReport)).toEqual([
    "fletcher · the last 1h · sampled every 1 s",
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

const hostReport: MonitorResult = {
  since: 0,
  from: 0,
  to: 3600,
  step: 15,
  sampledEvery: 1,
  series: [
    {
      series: { scope: "host" },
      now: { cpuPercent: 120, memoryBytes: 2e9 },
      summary: { cpu: stats(50, 300), memory: stats(1.8e9, 3e9) },
      points: [],
    },
    {
      series: { scope: "rig" },
      now: { cpuPercent: 1.2, memoryBytes: 90e6 },
      summary: { cpu: stats(1, 4), memory: stats(88e6, 95e6) },
      points: [],
    },
    projectReport.series[0]!,
    {
      series: { scope: "project", projectId: "p2", project: "pantry" },
      summary: { cpu: stats(6, 20), memory: stats(3e8, 4e8) },
      points: [],
    },
  ],
};

test("--all shows the Host's total, then Rig itself, then each Project", async () => {
  const h = harness(() => hostReport);
  expect(await runRigCli(["monitor", "--all"], h.deps)).toBe(0);
  expect(h.out()).toBe(
    [
      "This Host · the last 1h · sampled every 1 s",
      "",
      "             CPU  median  peak  Memory  median    peak",
      "Host        120%     50%  300%  2.0 GB  1.8 GB  3.0 GB",
      "Rig itself  1.2%    1.0%  4.0%   90 MB   88 MB   95 MB",
      "fletcher     96%     43%  297%  1.5 GB  1.5 GB  2.8 GB",
      "pantry         –    6.0%   20%       –  300 MB  400 MB",
      "",
    ].join("\n"),
  );
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
    { columns: 72 },
  );
  for (const line of lines.slice(2))
    expect(line.length).toBeLessThanOrEqual(72);
  expect(lines.find((line) => line.startsWith("  a-very"))).toContain("435 MB");
});

test("with nothing sampled, the table says so instead of showing an empty grid", () => {
  expect(
    monitorLines(
      { ...projectReport, series: [] },
      { window: { since: "7d" } },
    )[1],
  ).toBe(
    "No CPU or memory was sampled in the last 7d: nothing ran, or rigd was not sampling then.",
  );
});

test("rig monitor asks for the Project in the current directory, and --all for the whole Host, over the window given", async () => {
  const h = harness(() => projectReport);
  expect(await runRigCli(["monitor"], h.deps)).toBe(0);
  expect(await runRigCli(["monitor", "--all", "--since", "24h"], h.deps)).toBe(
    0,
  );
  expect(
    await runRigCli(
      [
        "monitor",
        "--project",
        "fletcher",
        "--since",
        "2026-10-11T02:00:00Z",
        "--until",
        "2026-10-11T04:30:00+02:00",
      ],
      h.deps,
    ),
  ).toBe(0);
  expect(h.requests.map(({ operationId: _id, ...request }) => request)).toEqual(
    [
      {
        action: "monitor",
        window: { since: "2026-10-12T09:00:00.000Z" },
        repoPath: "/workspace/fletcher",
      },
      {
        action: "monitor",
        window: { since: "2026-10-11T10:00:00.000Z" },
        host: true,
      },
      {
        action: "monitor",
        window: {
          since: "2026-10-11T02:00:00.000Z",
          until: "2026-10-11T02:30:00.000Z",
        },
        repoPath: "/workspace/fletcher",
        project: "fletcher",
      },
    ],
  );
  // A window with an end is closed, so it is printed once, worded as given.
  expect(h.out()).toContain(
    "fletcher · from 2026-10-11T02:00:00Z to 2026-10-11T04:30:00+02:00 ·",
  );
});

test("--all with --project, a time that is neither a duration nor an ISO time, or a since after the until, is refused before rigd is asked, as JSON with --json", async () => {
  const h = harness(() => projectReport);
  expect(
    await runRigCli(["monitor", "--all", "--project", "fletcher"], h.deps),
  ).toBe(1);
  expect(h.err()).toContain("--all covers every Project");
  expect(await runRigCli(["monitor", "--since", "yesterday"], h.deps)).toBe(1);
  expect(h.err()).toContain("neither a duration nor an ISO time");
  expect(
    await runRigCli(["monitor", "--since", "1h", "--until", "2h"], h.deps),
  ).toBe(1);
  expect(h.err()).toContain("is later than --until");
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
    expect(h.out()).toContain("--since <time>");
    expect(h.out()).toContain("--until <time>");
    expect(h.out()).toContain("--all");
  }
});

test("while watching, a --since duration moves with the clock and an ISO --since stays put", async () => {
  const sliding = harness(() => projectReport, { columns: 100, rows: 40 });
  await runRigCli(["monitor", "--since", "10m"], sliding.deps);
  expect(sliding.requests.map((request) => request.window?.since)).toEqual([
    "2026-10-12T09:50:00.000Z",
    "2026-10-12T09:50:01.000Z",
    "2026-10-12T09:50:02.000Z",
  ]);
  const fixed = harness(() => projectReport, { columns: 100, rows: 40 });
  await runRigCli(["monitor", "--since", "2026-10-12T08:00:00Z"], fixed.deps);
  expect(
    new Set(fixed.requests.map((request) => request.window?.since)),
  ).toEqual(new Set(["2026-10-12T08:00:00.000Z"]));
});

test("piped, the table is printed once; on a terminal it is redrawn in place every sample until Ctrl-C", async () => {
  const piped = harness(() => projectReport);
  expect(await runRigCli(["monitor"], piped.deps)).toBe(0);
  expect(piped.requests.length).toBe(1);
  expect(piped.out()).toBe(
    `${monitorLines(projectReport, { window: { since: "1h" } }).join("\n")}\n`,
  );

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
  const newest = [
    ...monitorLines(
      {
        ...projectReport,
        series: projectReport.series.map((each) =>
          each.now ? { ...each, now: { ...each.now, cpuPercent: 103 } } : each,
        ),
      },
      { columns: 100, window: { since: "1h" } },
    ),
    "",
    expect.stringContaining("Ctrl-C to stop"),
  ];
  // The watch drew on the alternate screen; after Ctrl-C the main screen is as it was, with the newest table below.
  expect(live.screen.alternate()).toBe(false);
  expect(live.screen.lines()).toEqual(["$ earlier output", ...newest]);
});

test("a table taller than the terminal keeps its first rows and says how many it left out, without scrolling", async () => {
  const h = harness(() => projectReport, { columns: 100, rows: 6 });
  await runRigCli(["monitor"], h.deps);
  expect(h.screen.scrolled()).toBe(false);
  // The whole table is left on the main screen once the watch ends.
  expect(h.screen.lines().at(-1)).toContain("Ctrl-C to stop");
  expect(h.out()).toMatch(/… \d+ more rows; enlarge the window/);
});

test("after the terminal is resized the table is drawn again to the new width, leaving earlier output alone", async () => {
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
  expect(h.screen.wrapped()).toBe(false);
  expect(h.screen.lines()[0]).toBe("$ earlier output");
  for (const line of h.screen.lines())
    expect(Bun.stringWidth(line)).toBeLessThan(50);
});

test("on a terminal one cell wide and one row tall nothing wraps or scrolls", async () => {
  const h = harness(() => projectReport, { columns: 1, rows: 1 });
  expect(await runRigCli(["monitor"], h.deps)).toBe(0);
  expect(h.screen.wrapped()).toBe(false);
  expect(h.screen.scrolled()).toBe(false);
});

test("a line is cut by display width, so wide characters never push it past the edge", () => {
  expect(fitted("日本語のサービス", 7)).toBe("日本…");
  expect(Bun.stringWidth(fitted("日本語のサービス", 6))).toBeLessThan(6);
  expect(fitted("abc", 2)).toBe("…");
  expect(fitted("abc", 1)).toBe("");
  expect(fitted("ab", 3)).toBe("ab");
  // An emoji with its variation selector is one character two cells wide, never split from its selector.
  expect(fitted("❤️❤️❤️❤️❤️", 7)).toBe("❤️❤️…");
  expect(Bun.stringWidth(fitted("❤️❤️❤️❤️❤️", 4))).toBeLessThan(4);
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
  // The watch left the alternate screen and kept the last table below the earlier output.
  expect(h.screen.alternate()).toBe(false);
  expect(h.screen.lines()[0]).toBe("$ earlier output");
  expect(h.screen.lines()[1]).toStartWith("fletcher · the last 1h");
});

test("with --until on a terminal the table is printed once, on the main screen", async () => {
  const h = harness(() => projectReport, { columns: 100, rows: 40 });
  expect(
    await runRigCli(["monitor", "--since", "2h", "--until", "1h"], h.deps),
  ).toBe(0);
  expect(h.requests.length).toBe(1);
  expect(h.out()).not.toContain("\x1b[?1049h");
  expect(h.screen.lines()[1]).toStartWith("fletcher · from 2h ago to 1h ago");
});

test("the watch reads again at the pace rigd samples: every second, or every five on the fallback reader", async () => {
  const native = harness(() => projectReport, { columns: 100, rows: 40 });
  await runRigCli(["monitor"], native.deps);
  expect(native.delays).toEqual([1000, 1000, 1000]);
  const fallback = harness(() => ({ ...projectReport, sampledEvery: 5 }), {
    columns: 100,
    rows: 40,
  });
  await runRigCli(["monitor"], fallback.deps);
  expect(fallback.delays).toEqual([5000, 5000, 5000]);
});

test("--json prints the report once, even on a terminal", async () => {
  const h = harness(() => projectReport, { columns: 100, rows: 40 });
  expect(await runRigCli(["monitor", "--json"], h.deps)).toBe(0);
  expect(JSON.parse(h.out())).toEqual(projectReport);
  expect(h.requests.length).toBe(1);
});

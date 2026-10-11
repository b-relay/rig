import { describe, expect, test } from "bun:test";
import { activityDays, dayLabel } from "../web/lib/activity";
import {
  healthOf,
  monogram,
  projectColor,
  projectHealth,
} from "../web/lib/health";
import {
  jobTile,
  matrixRows,
  matrixTile,
  projectMatrices,
  projectMatrix,
  until,
} from "../web/lib/matrix";
import { faviconCache, faviconUrl } from "../web/server/favicon";
import type {
  JobReport,
  ProjectStatusReport,
  TargetReport,
} from "../web/lib/types";

const target = (
  kind: TargetReport["kind"],
  name: string,
  extra: Partial<TargetReport> = {},
): TargetReport => ({ name, kind, state: "running", components: [], ...extra });
const report = (
  targets: TargetReport[],
  warnings: string[] = [],
): ProjectStatusReport => ({ project: "pantry", targets, warnings });
const project = (name: string, missing = false) => ({
  name,
  repoPath: `/repos/${name}`,
  targetCount: 0,
  ...(missing ? { missing: true as const } : {}),
});
const job = (fields: Partial<JobReport> = {}): JobReport => ({
  name: "close-books",
  schedule: "0 2 * * *",
  timeZone: "UTC",
  state: "idle",
  scheduled: true,
  ...fields,
});
const NOW = Date.parse("2026-10-11T12:00:00Z");

describe("health", () => {
  test("a state reads as one of four healths, motion needing a look", () => {
    expect(healthOf("healthy")).toBe("green");
    expect(healthOf("starting")).toBe("orange");
    expect(healthOf("degraded")).toBe("orange");
    expect(healthOf("failed")).toBe("red");
    expect(healthOf("timed-out")).toBe("red");
    expect(healthOf("deployed")).toBe("green");
    expect(healthOf("registered")).toBe("green");
    expect(healthOf("unchanged")).toBe("gray");
    expect(healthOf("stopped")).toBe("gray");
    expect(healthOf(undefined)).toBe("gray");
  });
  test("a Project is as healthy as its least healthy Target, gray with nothing running", () => {
    expect(projectHealth([])).toBe("gray");
    expect(projectHealth(["configured", "stopped"])).toBe("gray");
    expect(projectHealth(["stopped", "healthy"])).toBe("green");
    expect(projectHealth(["healthy", "starting"])).toBe("orange");
    expect(projectHealth(["starting", "failed"])).toBe("red");
  });
  test("a monogram is the first two letters or digits, and a Project keeps its colour", () => {
    expect(monogram("pantry")).toBe("PA");
    expect(monogram("-x")).toBe("X");
    expect(monogram("__")).toBe("?");
    expect(projectColor("pantry")).toBe(projectColor("pantry"));
    for (const name of ["a", "ledger", "quill", "rig", "zeta"])
      expect([1, 2, 3, 4, 5]).toContain(projectColor(name));
  });
});

describe("projectMatrix", () => {
  test("columns go working, stable, then Previews by name, and the stable route names the icon", () => {
    const matrix = projectMatrix({
      project: project("pantry"),
      status: {
        ok: true,
        value: report([
          target("preview", "zeta"),
          target("stable", "stable", { route: "pantry.test" }),
          target("preview", "alpha", { state: "failed" }),
          target("working", "working", { state: "configured" }),
        ]),
      },
    });
    expect(matrix.columns.map((each) => each.name)).toEqual([
      "working",
      "stable",
      "alpha",
      "zeta",
    ]);
    expect(matrix.href).toBe("/projects/pantry");
    expect(matrix.stableRoute).toBe("pantry.test");
    expect(matrix.health).toBe("red");
    expect(matrix.problem).toBeUndefined();
  });
  test("rows list every component in first-seen order with its kind, then every job", () => {
    const rows = matrixRows([
      target("working", "working", {
        components: [
          { name: "web", kind: "managed", state: "running" },
          { name: "cli", kind: "installed", state: "installed" },
        ],
      }),
      target("stable", "stable", {
        components: [
          { name: "db", kind: "persistent", state: "ready" },
          { name: "web", kind: "managed", state: "running" },
        ],
        jobs: [job()],
      }),
    ]);
    expect(rows.map((row) => [row.key, row.kind])).toEqual([
      ["component:web", "service"],
      ["component:cli", "tool"],
      ["component:db", "store"],
      ["job:close-books", "job"],
    ]);
  });
  test("a missing directory or a refused status is the matrix's problem; warnings are its notices", () => {
    const [gone, broken, noisy, pending] = projectMatrices([
      { project: project("gone", true) },
      {
        project: project("broken"),
        status: {
          ok: false,
          failure: { code: "DAEMON_DOWN", message: "rigd did not answer." },
        },
      },
      {
        project: project("noisy"),
        status: {
          ok: true,
          value: report([target("working", "working")], ["rig.yaml changed."]),
        },
      },
      { project: project("pending") },
    ]);
    expect(gone?.problem).toMatchObject({
      tone: "bad",
      href: "/projects/gone/settings",
    });
    expect(broken?.problem?.text).toBe("DAEMON_DOWN: rigd did not answer.");
    expect(broken?.columns).toEqual([]);
    expect(noisy?.notices).toEqual([
      { tone: "warn", href: "/projects/noisy", text: "rig.yaml changed." },
    ]);
    expect(pending).toMatchObject({ health: "gray", columns: [], rows: [] });
    expect(pending?.problem).toBeUndefined();
  });
});

describe("matrix tiles", () => {
  const stable = target("stable", "stable", {
    components: [
      { name: "web", kind: "managed", state: "starting", port: 4000, pid: 12 },
    ],
    jobs: [job({ nextRunAt: "2026-10-11T14:00:00Z" })],
  });
  test("a component tile carries its state, health, port and whether it moves", () => {
    expect(
      matrixTile(
        stable,
        { key: "component:web", name: "web", kind: "service" },
        NOW,
      ),
    ).toEqual({
      word: "starting",
      health: "orange",
      busy: true,
      detail: ":4000",
      title: "starting, pid 12",
    });
  });
  test("a row the Target does not have is absent", () => {
    expect(
      matrixTile(
        target("working", "working"),
        { key: "component:web", name: "web", kind: "service" },
        NOW,
      ),
    ).toEqual({ absent: true });
    expect(
      matrixTile(
        target("working", "working"),
        { key: "job:close-books", name: "close-books", kind: "job" },
        NOW,
      ),
    ).toEqual({ absent: true });
  });
  test("a job tile says how its last run ended and when it runs next", () => {
    expect(
      jobTile(job({ nextRunAt: "2026-10-11T14:00:00Z" }), NOW),
    ).toMatchObject({
      word: "never run",
      health: "gray",
      busy: false,
      detail: "in 2 h",
    });
    const last = {
      runId: "r",
      trigger: "schedule",
      startedAt: "2026-10-11T02:00:00Z",
      summary: "exit 1",
    };
    expect(
      jobTile(
        job({ last: { ...last, outcome: "failed" } } as Partial<JobReport>),
        NOW,
      ),
    ).toMatchObject({ word: "failed", health: "red" });
    expect(
      jobTile(
        job({ last: { ...last, outcome: "succeeded" } } as Partial<JobReport>),
        NOW,
      ),
    ).toMatchObject({ word: "succeeded", health: "green" });
    expect(jobTile(job({ state: "running" }), NOW)).toMatchObject({
      word: "running",
      health: "orange",
      busy: true,
    });
    expect(
      jobTile(job({ scheduled: false, reason: "The Target is stopped." }), NOW),
    ).toMatchObject({ title: "0 2 * * * UTC. The Target is stopped." });
  });
  test("a coming instant is said in its coarsest unit", () => {
    expect(until("2026-10-11T12:00:20Z", NOW)).toBe("in <1 min");
    expect(until("2026-10-11T12:30:00Z", NOW)).toBe("in 30 min");
    expect(until("2026-10-13T12:00:00Z", NOW)).toBe("in 2 d");
    expect(until("not a date", NOW)).toBe("not a date");
  });
});

describe("activity days", () => {
  test("Operations group by local day, newest day and newest first", () => {
    const now = new Date(2026, 9, 11, 15).getTime();
    const at = (day: number, hour: number) =>
      new Date(2026, 9, day, hour).toISOString();
    const days = activityDays(
      [
        { id: "a", occurredAt: at(9, 8) },
        { id: "b", occurredAt: at(10, 9) },
        { id: "c", occurredAt: at(11, 9) },
        { id: "d", occurredAt: at(11, 10) },
        { id: "e", occurredAt: "garbled" },
      ],
      now,
    );
    expect(
      days.map((day) => [
        day.label === "Today" ||
        day.label === "Yesterday" ||
        day.label === "Undated"
          ? day.label
          : "older",
        day.operations.map((each) => each.id),
      ]),
    ).toEqual([
      ["Today", ["d", "c"]],
      ["Yesterday", ["b"]],
      ["older", ["a"]],
      ["Undated", ["e"]],
    ]);
    expect(dayLabel(at(9, 8), now)).toContain("9");
  });
});

describe("project icons", () => {
  test("a favicon lives at the root of the route's origin", () => {
    expect(faviconUrl("pantry.test")).toBe("https://pantry.test/favicon.ico");
    expect(faviconUrl("http://127.0.0.1:8080/app")).toBe(
      "http://127.0.0.1:8080/favicon.ico",
    );
    expect(faviconUrl("not a host")).toBeUndefined();
  });
  test("only a small raster image is kept, and every answer is cached for its window", async () => {
    let now = 0;
    const calls: string[] = [];
    const answers: Record<string, Response | Error> = {
      "https://ok/favicon.ico": new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/x-icon" },
      }),
      "https://svg/favicon.ico": new Response("<svg/>", {
        headers: { "content-type": "image/svg+xml" },
      }),
      "https://html/favicon.ico": new Response("<html>", {
        headers: { "content-type": "text/html" },
      }),
      "https://huge/favicon.ico": new Response(new Uint8Array(200_000), {
        headers: { "content-type": "image/png" },
      }),
      "https://down/favicon.ico": new Error("ECONNREFUSED"),
    };
    const icons = faviconCache({
      now: () => now,
      ttlMs: 1000,
      fetch: async (url) => {
        calls.push(url);
        const answer = answers[url];
        if (answer instanceof Error) throw answer;
        return answer ?? new Response(null, { status: 404 });
      },
    });
    expect(await icons.get("https://ok/favicon.ico")).toEqual({
      body: new Uint8Array([1, 2, 3]),
      type: "image/x-icon",
    });
    expect(await icons.get("https://svg/favicon.ico")).toBeUndefined();
    expect(await icons.get("https://html/favicon.ico")).toBeUndefined();
    expect(await icons.get("https://huge/favicon.ico")).toBeUndefined();
    expect(await icons.get("https://down/favicon.ico")).toBeUndefined();
    expect(await icons.get("https://missing/favicon.ico")).toBeUndefined();
    await icons.get("https://down/favicon.ico");
    expect(
      calls.filter((url) => url === "https://down/favicon.ico"),
    ).toHaveLength(1);
    now = 2000;
    await icons.get("https://down/favicon.ico");
    expect(
      calls.filter((url) => url === "https://down/favicon.ico"),
    ).toHaveLength(2);
  });
});

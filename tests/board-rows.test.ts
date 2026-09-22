import { describe, expect, test } from "bun:test";
import { boardRows, NOT_STARTED } from "../web/lib/board-rows";
import type { ProjectStatusReport, TargetReport } from "../web/lib/types";

const target = (
  kind: TargetReport["kind"],
  name: string,
  extra: Partial<TargetReport> = {},
): TargetReport =>
  ({
    name,
    kind,
    state: "running",
    components: [],
    ...extra,
  }) as TargetReport;
const report = (
  targets: TargetReport[],
  warnings: string[] = [],
): ProjectStatusReport =>
  ({ project: "pantry", targets, warnings }) as unknown as ProjectStatusReport;
const project = (name: string, missing = false) => ({
  name,
  repoPath: `/repos/${name}`,
  targetCount: 0,
  ...(missing ? { missing: true as const } : {}),
});

describe("boardRows", () => {
  test("orders each Project's Targets Working copy, Stable, then Previews by name", () => {
    const { rows, notices } = boardRows([
      {
        project: project("pantry"),
        status: {
          ok: true,
          value: report([
            target("preview", "zeta"),
            target("live", "live"),
            target("preview", "alpha"),
            target("local", "local"),
          ]),
        },
      },
    ]);
    expect(rows.map((row) => row.name)).toEqual([
      "local",
      "live",
      "alpha",
      "zeta",
    ]);
    expect(rows[0]?.id).toBe("pantry/local:local");
    expect(rows[0]?.projectHref).toBe("/projects/pantry");
    expect(notices).toEqual([]);
  });

  test("a Project without a Working copy gets a placeholder row to start it from", () => {
    const { rows } = boardRows([
      {
        project: project("pantry"),
        status: { ok: true, value: report([target("live", "live")]) },
      },
    ]);
    expect(rows.map((row) => row.name)).toEqual([NOT_STARTED, "live"]);
    expect(rows[0]?.target).toBeUndefined();
    expect(rows[0]?.kindLabel).toBe("Working copy");
  });

  test("a row carries what the columns show, and the components as filterable text", () => {
    const { rows } = boardRows([
      {
        project: project("pantry"),
        status: {
          ok: true,
          value: report([
            target("live", "live", {
              branch: "main",
              commit: "abcdef1234567890",
              route: "pantry.rig.test",
              routePublished: false,
              components: [
                { name: "web", kind: "managed", state: "running", port: 4000 },
                { name: "worker", kind: "installed", state: "stopped" },
              ],
            }),
          ]),
        },
      },
    ]);
    const row = rows.find((each) => each.name === "live");
    expect(rows.map((each) => each.name)).toEqual([NOT_STARTED, "live"]);
    expect(row?.branch).toBe("main");
    expect(row?.commit).toBe("abcdef1234567890");
    expect(row?.route).toBe("pantry.rig.test");
    expect(row?.componentsText).toBe("web:4000 worker");
    expect(row?.warnings).toEqual(["The route is not published by Caddy."]);
  });

  test("a missing directory, a failed status and a report warning become notices, not rows", () => {
    const { rows, notices } = boardRows([
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
          value: report([target("local", "local")], ["rig.yaml changed."]),
        },
      },
      { project: project("pending") },
    ]);
    expect(rows.map((row) => row.project)).toEqual(["noisy"]);
    expect(notices.map((notice) => [notice.project, notice.tone])).toEqual([
      ["gone", "bad"],
      ["broken", "bad"],
      ["noisy", "warn"],
    ]);
    expect(notices[0]?.href).toBe("/projects/gone/settings");
    expect(notices[1]?.text).toBe("DAEMON_DOWN: rigd did not answer.");
    expect(notices[2]?.text).toBe("rig.yaml changed.");
  });
});

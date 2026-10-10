import { describe, expect, test } from "bun:test";
import {
  needsAttention,
  orderedTargets,
  overviewSummary,
  worstTone,
} from "../web/lib/overview";
import { targetVerbs } from "../web/lib/target-verbs";
import { componentPorts, exitText, routeLines } from "../web/lib/target-detail";
import { nextTheme, parseTheme, themeCookie } from "../web/lib/theme";
import { projectHref, targetHref } from "../web/lib/target";
import type { TargetReport } from "../web/lib/types";

const target = (fields: Partial<TargetReport>): TargetReport => ({
  name: "stable",
  kind: "stable",
  state: "running",
  components: [],
  ...fields,
});

describe("overview", () => {
  test("a group of states is summed up by its most urgent one", () => {
    expect(worstTone([])).toBe("idle");
    expect(worstTone(["stopped", "running"])).toBe("good");
    expect(worstTone(["running", "starting"])).toBe("busy");
    expect(worstTone(["healthy", "degraded", "running"])).toBe("warn");
    expect(worstTone(["unknown", "failed"])).toBe("bad");
  });
  test("a Target needs attention when its state fails or it carries a warning", () => {
    expect(needsAttention(target({ state: "healthy" }))).toBe(false);
    expect(needsAttention(target({ state: "stopped" }))).toBe(false);
    expect(needsAttention(target({ state: "unhealthy" }))).toBe(true);
    expect(needsAttention(target({ routePublished: false }))).toBe(true);
  });
  test("the counts take every Target, and a Project rigd could not report on counts as needing attention", () => {
    const summary = overviewSummary([
      {
        project: { name: "a", repoPath: "/a", targetCount: 2 },
        status: {
          ok: true,
          value: {
            project: "a",
            targets: [
              target({ state: "healthy" }),
              target({ name: "working", kind: "working", state: "failed" }),
            ],
          },
        },
      },
      {
        project: { name: "b", repoPath: "/b", targetCount: 0 },
        status: { ok: false, failure: { code: "X", message: "no" } },
      },
      {
        project: { name: "c", repoPath: "/c", targetCount: 0, missing: true },
      },
    ]);
    expect(summary).toEqual({
      projects: 3,
      targets: 2,
      live: 1,
      attention: 3,
    });
  });
  test("Targets are listed working, stable, then Previews by name", () => {
    expect(
      orderedTargets([
        target({ name: "zeta", kind: "preview" }),
        target({ name: "stable", kind: "stable" }),
        target({ name: "alpha", kind: "preview" }),
        target({ name: "working", kind: "working" }),
      ]).map((each) => each.name),
    ).toEqual(["working", "stable", "alpha", "zeta"]);
  });
});

describe("target actions", () => {
  test("a stopped Target is started and a running one restarted or stopped", () => {
    expect(
      targetVerbs(target({ kind: "working", state: "stopped" })).primary,
    ).toEqual(["up"]);
    expect(
      targetVerbs(target({ kind: "working", state: "running" })).primary,
    ).toEqual(["restart", "down"]);
  });
  test("a deployed role can always deploy again; a Preview can also be destroyed", () => {
    const stable = targetVerbs(target({ state: "healthy" }));
    expect(stable.primary).toEqual(["restart", "down", "deploy"]);
    expect(stable.all).not.toContain("destroy");
    const preview = targetVerbs(
      target({ kind: "preview", name: "x", branch: "feat/x", state: "failed" }),
    );
    expect(preview.primary).toEqual(["up", "deploy"]);
    expect(preview.all).toContain("destroy");
  });
  test("a stable Target that was never deployed only deploys; a configured working Target only starts", () => {
    expect(targetVerbs(target({ state: "configured" }))).toEqual({
      primary: ["deploy"],
      all: ["deploy"],
    });
    expect(
      targetVerbs(target({ kind: "working", state: "configured" })),
    ).toEqual({ primary: ["up"], all: ["up"] });
  });
  test("a Preview without a recorded Branch is not deployed again from the page", () => {
    expect(
      targetVerbs(target({ kind: "preview", name: "x" })).all,
    ).not.toContain("deploy");
  });
});

describe("target detail", () => {
  test("named ports are listed by name, and a plan without names gives its one port", () => {
    expect(componentPorts({ port: 1, ports: { http: 1, admin: 2 } })).toEqual([
      { name: "http", port: 1 },
      { name: "admin", port: 2 },
    ]);
    expect(componentPorts({ port: 5 })).toEqual([{ port: 5 }]);
    expect(componentPorts({})).toEqual([]);
  });
  test("a stopped Service's exit is worded with its code or signal", () => {
    expect(exitText({})).toBeUndefined();
    expect(exitText({ exit: "failed", exitCode: 2 })).toBe(
      "Exited with a failure (code 2).",
    );
    expect(exitText({ exit: "requested", signal: "SIGTERM" })).toBe(
      "Stopped on request (signal SIGTERM).",
    );
    expect(exitText({ exit: "unknown" })).toBe(
      "Gone, with nothing recording how.",
    );
  });
  test("routes come from the recorded map, or from the Service the route marks on an older plan", () => {
    expect(
      routeLines({
        route: "app.test",
        routes: [
          { prefix: "/api", service: "api", port: 2 },
          { prefix: "/", service: "web", port: 1 },
        ],
        components: [],
      }),
    ).toEqual([
      { url: "https://app.test/api", prefix: "/api", service: "api", port: 2 },
      { url: "https://app.test/", prefix: "/", service: "web", port: 1 },
    ]);
    expect(
      routeLines({
        route: "app.test",
        components: [
          {
            name: "web",
            kind: "managed",
            state: "running",
            port: 1,
            route: "app.test",
          },
        ],
      }),
    ).toEqual([
      { url: "https://app.test/", prefix: "/", service: "web", port: 1 },
    ]);
    expect(routeLines({ components: [] })).toEqual([]);
  });
  test("a Target's page sits under its Project's, with its name escaped", () => {
    expect(projectHref("pantry")).toBe("/projects/pantry");
    expect(targetHref("pantry", "feat-x")).toBe(
      "/projects/pantry/targets/feat-x",
    );
  });
});

describe("theme", () => {
  test("the switch cycles system, light and dark, and only those two words are read back", () => {
    expect(nextTheme(undefined)).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBeUndefined();
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("blue")).toBeUndefined();
    expect(parseTheme(undefined)).toBeUndefined();
  });
  test("following the system again deletes the cookie", () => {
    expect(themeCookie("dark")).toStartWith("rig_theme=dark; Path=/;");
    expect(themeCookie(undefined)).toContain("Max-Age=0");
  });
});

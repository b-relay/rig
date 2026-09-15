import { expect, test } from "bun:test";
import { renderLogs, renderResult, renderStatus } from "./output";
import type { ProjectStatusReport } from "../domain/project-status";

/** A right-to-left override, an 8-bit CSI colour, a zero-width space, and a newline. */
const hostile = "app‮31m​name\ntail";
test("status, result and log text drop bidi overrides, zero-width and C1 controls, and keep word boundaries", () => {
  const report: ProjectStatusReport = {
    project: hostile,
    targets: [
      {
        name: hostile,
        kind: "preview",
        state: "unknown",
        branch: hostile,
        components: [
          { name: hostile, kind: "managed", state: "unknown", reason: hostile },
        ],
      },
    ],
    warnings: [hostile],
  };
  const rendered = [
    renderStatus(report),
    renderResult("list", {
      ownership: "ready",
      projects: [{ name: hostile, repoPath: hostile, targetCount: 1 }],
    }),
    renderResult("up", {
      project: hostile,
      target: hostile,
      outcome: hostile,
      warnings: [hostile],
    }),
    renderLogs(
      {
        project: hostile,
        target: hostile,
        entries: [
          {
            timestamp: "2026-09-14T10:00:00.000Z",
            component: hostile,
            stream: "stdout",
            line: hostile,
          },
        ],
        cursor: "0",
      },
      true,
    ),
  ].join("");
  for (const forbidden of ["‮", "", "​", "31m"])
    expect(rendered).not.toContain(forbidden);
  expect(rendered).toContain("appname tail");
});

test("list marks a registered directory that no longer exists", () => {
  expect(
    renderResult("list", {
      ownership: "ready",
      projects: [
        { name: "demo", repoPath: "/gone", targetCount: 0, missing: true },
        { name: "app", repoPath: "/here", targetCount: 2 },
      ],
    }),
  ).toBe(
    "demo  0 Targets  /gone  (directory missing: rig repoint or rig forget demo)\napp  2 Targets  /here\n",
  );
});

test("logs print the UTC clock with its zone marker so it cannot pass for local time", () => {
  expect(
    renderLogs(
      {
        project: "app",
        target: "live",
        entries: [
          {
            timestamp: "2026-09-14T23:30:00.000Z",
            component: "web",
            stream: "stdout",
            line: "ready",
          },
        ],
        cursor: "0",
      },
      false,
    ),
  ).toBe("23:30:00Z  web  > ready\n");
});

test("list says when rigd cannot observe Targets because legacy adoption is pending", () => {
  expect(
    renderResult("list", {
      ownership: "unknown",
      projects: [{ name: "app", repoPath: "/here", targetCount: 2 }],
    }),
  ).toBe(
    "app  2 Targets  /here\nWarning: rigd is not observing Targets: legacy adoption is pending, so Target counts come from the registry only. Run rig doctor.\n",
  );
});

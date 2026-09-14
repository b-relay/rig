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
      runningTargets: 0,
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

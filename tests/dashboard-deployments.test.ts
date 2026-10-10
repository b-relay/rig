import { expect, test } from "bun:test";
import {
  deploymentRows,
  formatDuration,
  rollbackCommand,
} from "../web/lib/deployments";
import {
  DEPLOYMENTS_RETAINED,
  deploymentHistory,
  recordDeployment,
} from "../src/domain/deployments";
import type { DeploymentRecord, RuntimeState } from "../src/domain/runtime";
import type { DeploymentReport } from "../web/lib/types";

const deploy = (
  id: string,
  fields: Partial<DeploymentReport> = {},
): DeploymentReport => ({
  id,
  project: "demo",
  target: "stable",
  kind: "stable",
  branch: "main",
  commit: id,
  outcome: "deployed",
  startedAt: "2026-10-10T10:00:00.000Z",
  finishedAt: "2026-10-10T10:00:05.000Z",
  durationMs: 5000,
  ...fields,
});

test("the history reads newest first; the newest deploy of the running Commit is current and earlier Commits can be rolled back to", () => {
  const rows = deploymentRows(
    [
      deploy("c1"),
      deploy("c2"),
      deploy("c2b", { commit: "c2", outcome: "unchanged" }),
      deploy("c3", { outcome: "failed" }),
    ],
    [{ name: "stable", commit: "c2" }],
  );
  expect(rows.map((row) => [row.id, row.current, row.rollback])).toEqual([
    ["c3", false, false],
    ["c2b", true, false],
    ["c2", false, false],
    ["c1", false, true],
  ]);
});

test("a destroyed Preview's deploys stay listed but cannot be rolled back to", () => {
  const rows = deploymentRows(
    [deploy("p1", { target: "gone", kind: "preview" })],
    [{ name: "stable", commit: "c9" }],
  );
  expect(rows[0]).toMatchObject({ current: false, rollback: false });
});

test("a rollback deploys the exact Commit of the Branch to the Target it came from", () => {
  expect(rollbackCommand("demo", deploy("c1"))).toEqual({
    action: "deploy",
    project: "demo",
    target: "stable",
    branch: "main",
    commit: "c1",
  });
  expect(
    rollbackCommand(
      "demo",
      deploy("c1", {
        kind: "preview",
        target: "feat-x-1a2b",
        branch: "feat/x",
      }),
    ),
  ).toEqual({
    action: "deploy",
    project: "demo",
    target: "preview",
    deployment: "feat-x-1a2b",
    branch: "feat/x",
    commit: "c1",
  });
});

test("durations read in the two largest units that say something", () => {
  expect(formatDuration(850)).toBe("850 ms");
  expect(formatDuration(12_400)).toBe("12 s");
  expect(formatDuration(184_000)).toBe("3 min 4 s");
  expect(formatDuration(120_000)).toBe("2 min");
  expect(formatDuration(3_720_000)).toBe("1 h 2 min");
});

test("rigd keeps a bounded history and reports one Project's deploys without its internal id", () => {
  const state = {
    version: 6,
    projects: [],
    targets: [],
    activity: [],
  } as RuntimeState;
  const record = (id: string, projectId = "p"): DeploymentRecord => ({
    id,
    projectId,
    project: "demo",
    target: "stable",
    kind: "stable",
    outcome: "deployed",
    startedAt: "2026-10-10T10:00:00.000Z",
    finishedAt: "2026-10-10T10:00:02.500Z",
  });
  for (let index = 0; index < DEPLOYMENTS_RETAINED + 3; index++)
    recordDeployment(state, record(`d${index}`, index % 2 ? "q" : "p"));
  expect(state.deployments).toHaveLength(DEPLOYMENTS_RETAINED);
  expect(state.deployments![0]!.id).toBe("d3");
  const history = deploymentHistory(state.deployments, "p", 2);
  expect(history.map((entry) => entry.id)).toEqual([
    `d${DEPLOYMENTS_RETAINED}`,
    `d${DEPLOYMENTS_RETAINED + 2}`,
  ]);
  expect(history[0]).not.toHaveProperty("projectId");
  expect(history[0]!.durationMs).toBe(2500);
});

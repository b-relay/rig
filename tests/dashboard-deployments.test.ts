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
import { STATE_VERSION } from "../src/runtime/state-schema";

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

test("a Preview made again under the same name keeps its old deploys listed, but they are neither current nor a rollback", () => {
  const preview = (id: string, targetId: string | undefined, commit: string) =>
    deploy(id, {
      target: "feature",
      kind: "preview",
      commit,
      ...(targetId ? { targetId } : {}),
    });
  const rows = deploymentRows(
    [
      preview("a", "old", "A"),
      // Recorded before rigd kept Target ids: a Preview's cannot be told apart, so it offers nothing.
      preview("legacy", undefined, "L"),
      // The Commit the new Preview runs too: still not that Preview's deploy.
      preview("c-old", "old", "C"),
      preview("b", "new", "B"),
      preview("c", "new", "C"),
    ],
    [{ id: "new", name: "feature", commit: "C" }],
  );
  expect(rows.map((row) => [row.id, row.current, row.rollback])).toEqual([
    ["c", true, false],
    ["b", false, true],
    ["c-old", false, false],
    ["legacy", false, false],
    ["a", false, false],
  ]);
});

test("a stable deploy recorded before rigd kept Target ids can still be rolled back to, since stable is never destroyed", () => {
  const rows = deploymentRows(
    [deploy("c1"), deploy("c2", { targetId: "t" })],
    [{ id: "t", name: "stable", commit: "c2" }],
  );
  expect(rows.map((row) => [row.id, row.current, row.rollback])).toEqual([
    ["c2", true, false],
    ["c1", false, true],
  ]);
});

test("no rollback is offered of a Target rigd refuses to deploy now", () => {
  const rows = deploymentRows(
    [deploy("c1", { targetId: "t" }), deploy("c2", { targetId: "t" })],
    [
      {
        id: "t",
        name: "stable",
        commit: "c2",
        refusals: {
          deploy: {
            code: "TARGET_OFF",
            message: "The stable Target is off in rig.yaml.",
            hint: "Add it.",
          },
        },
      },
    ],
  );
  expect(rows.map((row) => row.rollback)).toEqual([false, false]);
});

test("a rollback names the Target it was offered for, so rigd refuses it should a new Target have taken the name", () => {
  expect(
    rollbackCommand(
      "demo",
      deploy("p1", {
        target: "feature",
        targetId: "t-1",
        kind: "preview",
      }),
    ),
  ).toMatchObject({ targetId: "t-1", deployment: "feature", commit: "p1" });
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
    version: STATE_VERSION,
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

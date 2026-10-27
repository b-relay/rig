import { expect, test } from "bun:test";
import type { PlanJob, TargetPlan } from "../src/config/types";
import type { TargetRecord } from "../src/domain/runtime";
import { jobReports } from "../src/runtime/job-status";

/* Issue #725: while `rig deploy` of a running Stable Target ran, every job in `rig status` said "stable is stopped, so its
 * jobs are not scheduled; rig up … schedules them again". The Target was running and meant to keep running. What rigd
 * stores during a deploy is the candidate: `desired: "stopped"` until its start completes (planTarget), with
 * `deploymentIncomplete` and a pending `recovery` that records the previous plan meant to run. Holding the jobs is right;
 * the reason, and its advice to run `rig up`, are not. */

const plan: TargetPlan = {
  project: "melody",
  target: "stable",
  workspacePath: "/rig/targets/p1/t1/revisions/r2",
  dataRoot: "/rig/data",
  deploymentName: "stable",
  branchSlug: "stable",
  subdomain: "stable",
  providers: { processSupervisor: "rigd" },
  components: [],
  preparedComponents: [],
  jobs: [
    {
      name: "search-index-incremental",
      command: "pnpm search-index --incremental",
      env: {},
      schedule: "*/15 * * * *",
      timeZone: "UTC",
    } satisfies PlanJob,
  ],
} as TargetPlan;

/** The Stable Target as a deploy from a running Deployment stores it before its start completes. */
const deploying: TargetRecord = {
  id: "t1",
  projectId: "p1",
  name: "stable",
  kind: "stable",
  desired: "stopped",
  deploymentIncomplete: true,
  recovery: {
    operationId: "404d10ee-c908-4ff4-856d-97ad0796ac65",
    plan: { ...plan, workspacePath: "/rig/targets/p1/t1/revisions/r1" },
    branch: "main",
    commit: "820ced9",
    desired: "running",
    stage: "pending",
  },
  branch: "main",
  commit: "b1f6b80",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-27T15:22:43.000Z",
  logRoot: "/rig/logs",
  sourceRoot: "/rig/targets/p1/t1/revisions",
  plan,
};

test("#725: during a deploy of a running Target, its jobs say the deploy holds them, not that the Target is stopped", () => {
  const [report] = jobReports(
    deploying,
    [],
    Date.parse("2026-10-27T15:25:00.000Z"),
    { timeZone: () => "UTC" },
    true,
  )!;
  expect(report!.scheduled).toBe(false);
  // Fails at v1.0.1: "stable is stopped, so its jobs are not scheduled; rig up stable --project melody schedules them again."
  expect(report!.reason).toBe(
    "stable has an unfinished deploy or transition, so its jobs are not scheduled.",
  );
});

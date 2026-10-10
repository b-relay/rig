import { test, expect } from "bun:test";
import { renderResult, renderStatus } from "../src/cli/output";
test("a deploy that replaced Previews lists each retirement before its own outcome", () => {
  expect(
    renderResult("deploy", {
      project: "share",
      target: "feature-d-1234abcd",
      outcome: "deployed",
      branch: "feature/d",
      commit: "470a510f7f4c1b2d3e4f5a6b7c8d9e0f1a2b3c4d",
      retired: [
        {
          target: "feature-b-9876fedc",
          branch: "feature/b",
          reason: "Preview limit",
        },
      ],
    }),
  ).toBe(
    "share feature-b-9876fedc retired feature/b (Preview limit)\nshare feature-d-1234abcd deployed feature/d@470a510\n",
  );
});
test("a deploy outcome names the Branch and Commits so a wrong Project is visible at a glance", () => {
  expect(
    renderResult("deploy", {
      project: "share",
      target: "stable",
      outcome: "deployed",
      branch: "main",
      commit: "470a510f7f4c1b2d3e4f5a6b7c8d9e0f1a2b3c4d",
      previousCommit: "83496f8dafde3909a7a7121ef496aeae4dacd2ef",
    }),
  ).toBe("share stable deployed main@470a510 (was 83496f8)\n");
  expect(
    renderResult("deploy", {
      project: "share",
      target: "preview-x",
      outcome: "deployed",
      branch: "feat",
      commit: "1234567890",
    }),
  ).toBe("share preview-x deployed feat@1234567\n");
  expect(
    renderResult("up", {
      project: "share",
      target: "stable",
      outcome: "started",
      branch: "main",
      commit: "1234567890",
    }),
  ).toBe("share stable started\n");
});

test("status lists a Target's jobs with their schedule, last and next run, and a failed last run among the failures", () => {
  const text = renderStatus(
    {
      project: "melody",
      targets: [
        {
          name: "stable",
          kind: "stable",
          state: "running",
          components: [{ name: "api", kind: "managed", state: "running" }],
          jobs: [
            {
              name: "link-resolver",
              schedule: "17 */6 * * *",
              timeZone: "America/Chicago",
              state: "idle",
              scheduled: true,
              nextRunAt: "2026-10-10T23:17:00.000Z",
              last: {
                trigger: "schedule",
                startedAt: "2026-10-10T17:17:00.000Z",
                finishedAt: "2026-10-10T17:20:12.000Z",
                durationMs: 192000,
                outcome: "failed",
                exitCode: 1,
                summary: "failed in 3m12s: exit 1",
              },
            },
            {
              name: "mb-mirror",
              schedule: "0 7 * * 3,6",
              timeZone: "UTC",
              state: "running",
              scheduled: false,
              running: {
                trigger: "manual",
                startedAt: "2026-10-10T19:00:00.000Z",
                summary: "running",
              },
              reason: "stable is stopped, so its jobs are not scheduled.",
            },
          ],
        },
      ],
    },
    new Date("2026-10-10T20:00:00.000Z"),
  );
  expect(text).toContain(
    "    link-resolver  17 */6 * * * America/Chicago · last failed in 3m12s: exit 1, 3h ago · next Sat, 18:17 CDT (in 3h)",
  );
  expect(text).toContain(
    "    mb-mirror  0 7 * * 3,6 UTC · running since Sat, 19:00 UTC (60m)",
  );
  expect(text).toContain(
    "      stable is stopped, so its jobs are not scheduled.",
  );
  expect(text).toContain(
    "Failures\n  stable link-resolver: last run failed in 3m12s: exit 1",
  );
});

test("rig run answers with the job it started", () => {
  expect(
    renderResult("run", {
      project: "melody",
      target: "stable",
      job: "mb-mirror",
      outcome: "started",
    }),
  ).toBe("melody stable mb-mirror started\n");
});

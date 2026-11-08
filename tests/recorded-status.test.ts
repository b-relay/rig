import { expect, test } from "bun:test";
import type { TargetRecord } from "../src/domain/runtime";
import type { TargetReport } from "../src/domain/project-status";
import { timerObservationDeadline } from "../src/runtime/bounded-observations";
import { projectStatus } from "../src/runtime/project-status";
import {
  recordedReport,
  recordedWarnings,
  showsRoute,
  stoppingReport,
  unpublishedReport,
  unresolvedRecoveryReport,
  withConfiguredComponents,
  withRefusals,
} from "../src/runtime/recorded-status";

const observed = (): TargetReport => ({
  id: "t1",
  name: "stable",
  kind: "stable",
  components: [
    { name: "web", kind: "managed", state: "running", port: 4100, pid: 7 },
    { name: "api", kind: "managed", state: "stopped", reason: "Exited 1." },
  ],
  state: "degraded",
});
const stop = (service: string, killAt: string) => ({
  service,
  target: "stable",
  state: "stopping" as const,
  since: "2026-11-07T05:00:00.000Z",
  killAt,
});
const recorded = (fields: Partial<TargetRecord> = {}) =>
  ({
    id: "t1",
    name: "stable",
    kind: "stable",
    plan: { components: [] },
    ...fields,
  }) as unknown as TargetRecord;

test("withConfiguredComponents adds what rig.yaml defines after what the Target shows, never twice", () => {
  const report = withConfiguredComponents(observed(), [
    { name: "web", kind: "managed", state: "configured" },
    { name: "cli", kind: "installed", state: "configured" },
  ]);
  expect(report.components.map((c) => [c.name, c.state])).toEqual([
    ["web", "running"],
    ["api", "stopped"],
    ["cli", "configured"],
  ]);
});

test("stoppingReport makes the Target and each Service waited on stopping with its kill time, the last Operation's kept", () => {
  const report = stoppingReport(observed(), [
    stop("api", "2026-11-07T05:00:10.000Z"),
    stop("api", "2026-11-07T05:00:20.000Z"),
    stop("gone", "2026-11-07T05:00:30.000Z"),
  ]);
  expect(report.state).toBe("stopping");
  expect(report.components).toEqual([
    observed().components[0]!,
    {
      name: "api",
      kind: "managed",
      state: "stopping",
      reason: "Exited 1.",
      killAt: "2026-11-07T05:00:20.000Z",
    },
  ]);
});

test("unresolvedRecoveryReport makes the Target and every Component unknown for the unresolved recovery", () => {
  const report = unresolvedRecoveryReport(observed());
  expect(report.state).toBe("unknown");
  expect(report.components.map((c) => [c.state, c.reason])).toEqual([
    ["unknown", "Deployment recovery is unresolved."],
    ["unknown", "Deployment recovery is unresolved."],
  ]);
});

test("recordedReport ranks its evidence: an unresolved recovery overrides an active stop, which overrides observation", () => {
  const evidence = {
    configured: [
      { name: "cli", kind: "installed" as const, state: "configured" as const },
    ],
    jobs: [],
    stops: [stop("api", "2026-11-07T05:00:10.000Z")],
    build: { kind: "completed" as const, value: { state: "running" as const } },
  };
  const stopping = recordedReport(observed(), evidence);
  expect(stopping.state).toBe("stopping");
  expect(stopping.components.map((c) => c.state)).toEqual([
    "running",
    "stopping",
    "configured",
  ]);
  const abandoned = recordedReport(observed(), {
    ...evidence,
    recovery: "abandoned",
  });
  expect(abandoned.state).toBe("unknown");
  expect(abandoned.components.map((c) => c.state)).toEqual([
    "unknown",
    "unknown",
    "unknown",
  ]);
  // The kill time of the stop stays beside the recovery's unknown.
  expect(abandoned.components[1]).toMatchObject({
    killAt: "2026-11-07T05:00:10.000Z",
    reason: "Deployment recovery is unresolved.",
  });
  expect(Object.keys(abandoned)).toEqual([
    "id",
    "name",
    "kind",
    "components",
    "state",
    "jobs",
    "leftoverBuild",
  ]);
  // A live recovery is a deploy in progress, which observation shows as it is.
  expect(recordedReport(observed(), { recovery: "live" })).toEqual(observed());
});

test("withRefusals adds refusals only when there are some", () => {
  const refusal = { code: "TARGET_OFF", message: "off", hint: "turn it on" };
  expect(withRefusals(observed(), {})).toEqual(observed());
  expect(withRefusals(observed(), { up: refusal }).refusals).toEqual({
    up: refusal,
  });
});

test("showsRoute and unpublishedReport mark only a report that shows a route, its Target's or a Component's", () => {
  expect(showsRoute(observed())).toBe(false);
  expect(unpublishedReport(observed())).toEqual(observed());
  const routed = { ...observed(), route: "app.test" };
  expect(unpublishedReport(routed).routePublished).toBe(false);
  const serviceRouted = observed();
  serviceRouted.components[1]!.route = "api.app.test";
  expect(showsRoute(serviceRouted)).toBe(true);
});

test("recordedWarnings groups each kind of warning in Target order", () => {
  const live = recorded({
    name: "live",
    recovery: { operationId: "op-1" } as TargetRecord["recovery"],
  });
  const abandoned = recorded({
    name: "abandoned",
    kind: "preview",
    deploymentIncomplete: true,
    destructionPending: true,
    recovery: {} as TargetRecord["recovery"],
  });
  const incomplete = recorded({
    name: "incomplete",
    kind: "preview",
    deploymentIncomplete: true,
    destructionPending: true,
  });
  const warnings = recordedWarnings([
    {
      target: incomplete,
      evidence: { build: { kind: "expired" } },
    },
    { target: abandoned, evidence: { recovery: "abandoned" } },
    {
      target: live,
      evidence: {
        recovery: "live",
        build: { kind: "completed", value: { state: "running", pid: 9 } },
      },
    },
  ]);
  expect(warnings.map((w) => w.slice(0, 40))).toEqual([
    "abandoned has an unresolved deployment t",
    "live: deploy in progress (operation op-1",
    "incomplete: the last deploy did not comp",
    "incomplete: Preview destruction is incom",
    "abandoned: Preview destruction is incomp",
    "incomplete: whether a build an earlier r",
    "live: a build an earlier rigd started is",
  ]);
  expect(warnings[5]).toContain(
    "(Observation did not complete before the status deadline.)",
  );
  expect(warnings[6]).toContain("(process group 9)");
  expect(
    recordedWarnings([
      {
        target: incomplete,
        evidence: { build: { kind: "completed", value: { state: "stopped" } } },
      },
    ]),
  ).toHaveLength(2);
});

test("status of a Target an Operation is stopping whose deploy no daemon runs any more: the recovery's unknown wins over stopping", async () => {
  const target = {
    id: "t1",
    projectId: "p",
    name: "stable",
    kind: "stable",
    branch: "main",
    desired: "running",
    createdAt: "",
    updatedAt: "",
    logRoot: "/logs",
    plan: {
      components: [
        { name: "web", kind: "managed", port: 4100 },
        { name: "api", kind: "managed", port: 4200 },
      ],
    },
    recovery: { stage: "pending", desired: "running", operationId: "op-dead" },
  } as unknown as TargetRecord;
  const report = await projectStatus(
    { id: "p", name: "app", repoPath: "/repo" },
    [target],
    { target: "stable" },
    {
      observations: {
        async process() {
          return { state: "running", pid: 7 };
        },
        async health() {
          return { ready: true };
        },
        async artifact() {
          return "installed";
        },
        async persistent() {
          return true;
        },
        async listening() {
          return [];
        },
      },
      observationBudgetMs: 2000,
      observationDeadline: timerObservationDeadline,
      documents: {
        async read() {
          throw new Error("no rig.yaml here");
        },
      },
      inProgress: () => false,
      stopping: () => true,
      serviceStops: () => [stop("api", "2026-11-07T05:00:10.000Z")],
      async inspectProxy() {
        throw new Error("not asked: nothing is routed");
      },
    },
  );
  expect(report.targets[0]).toMatchObject({
    state: "unknown",
    components: [
      {
        name: "web",
        state: "unknown",
        reason: "Deployment recovery is unresolved.",
      },
      {
        name: "api",
        state: "unknown",
        reason: "Deployment recovery is unresolved.",
        killAt: "2026-11-07T05:00:10.000Z",
      },
    ],
  });
  expect(report.targets[0]!.components[0]).not.toHaveProperty("killAt");
  expect(report.warnings!.slice(1)).toEqual([
    "stable has an unresolved deployment transition; run rig down stable to stop both recorded plans.",
  ]);
});

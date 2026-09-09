import { expect, test } from "bun:test";
import type {
  RuntimeState,
  StateStore,
  TargetRecord,
} from "../src/domain/runtime";
import { monitorRuntimeFailures } from "../src/runtime/activity";
const target = {
  id: "t",
  projectId: "p",
  name: "live",
  desired: "running",
  updatedAt: "2026-09-09T10:00:00Z",
  plan: { components: [{ kind: "managed", name: "web" }] },
} as TargetRecord;
function fixture() {
  const state: RuntimeState = {
    version: 2,
    projects: [
      {
        id: "p",
        name: "app",
        repoPath: "/app",
        configPath: "/app/rig.yaml",
        createdAt: target.updatedAt,
      },
    ],
    targets: [structuredClone(target)],
    activity: [],
  };
  const store: StateStore = {
    async read() {
      return structuredClone(state);
    },
    async update(change) {
      await change(state);
    },
  };
  return { state, store };
}
test("terminal desired-running crash is recorded once across monitor calls with persistent evidence", async () => {
  const { state, store } = fixture();
  const options = {
    store,
    observations: {
      async process() {
        return { state: "stopped" as const, exitCode: 7 };
      },
    },
    now: () => "2026-09-09T10:01:00Z",
  };
  expect(await monitorRuntimeFailures(options)).toEqual({ recorded: 1 });
  expect(await monitorRuntimeFailures({ ...options })).toEqual({ recorded: 0 });
  expect(state.activity).toHaveLength(1);
  expect(state.activity[0]).toMatchObject({
    project: "app",
    target: "live",
    action: "crash",
    outcome: "failed",
    message: "web exited with code 7.",
  });
  state.targets[0]!.updatedAt = "2026-09-09T10:02:00Z";
  expect(await monitorRuntimeFailures(options)).toEqual({ recorded: 1 });
});
test("intentional stop, restart backoff, unknown observations and a racing down never become crash activity", async () => {
  const { state, store } = fixture(),
    now = () => "2026-09-09T10:01:00Z";
  state.targets[0]!.desired = "stopped";
  await monitorRuntimeFailures({
    store,
    now,
    observations: {
      async process() {
        throw Error("must not probe intentionally stopped Target");
      },
    },
  });
  state.targets[0]!.desired = "running";
  await monitorRuntimeFailures({
    store,
    now,
    observations: {
      async process() {
        return { state: "stopped", exitCode: 7, restartPending: true };
      },
    },
  });
  await monitorRuntimeFailures({
    store,
    now,
    observations: {
      async process() {
        return { state: "unknown" };
      },
    },
  });
  await monitorRuntimeFailures({
    store,
    now,
    observations: {
      async process() {
        state.targets[0]!.desired = "stopped";
        return { state: "stopped", exitCode: 7 };
      },
    },
  });
  expect(state.activity).toEqual([]);
});
test("one deadline bounds stuck providers and process absence without exit evidence is not invented crash history", async () => {
  const { state, store } = fixture(),
    now = () => "2026-09-09T10:01:00Z";
  await monitorRuntimeFailures({
    store,
    now,
    observations: {
      async process() {
        return { state: "stopped" };
      },
    },
  });
  const start = performance.now();
  expect(
    await monitorRuntimeFailures({
      store,
      now,
      budgetMs: 20,
      observations: {
        async process() {
          return await new Promise(() => {});
        },
      },
    }),
  ).toEqual({ recorded: 0 });
  expect(performance.now() - start).toBeLessThan(200);
  expect(state.activity).toEqual([]);
});

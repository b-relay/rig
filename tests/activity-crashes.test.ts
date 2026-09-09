import { controlledDeadline } from "./controlled-observation-deadline";
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
test("process absence without exit evidence is not invented crash history", async () => {
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
  expect(state.activity).toEqual([]);
});

for (const late of ["resolution", "rejection"] as const) {
  test(`controlled expiry ignores late Activity ${late} and cleans its deadline`, async () => {
    const { store } = fixture();
    const deadline = controlledDeadline();
    let reject!: (error: Error) => void;
    let complete!: (value: { state: "stopped"; exitCode: number }) => void;
    let signal!: AbortSignal;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const work = new Promise<{ state: "stopped"; exitCode: number }>(
      (resolve, fail) => {
        complete = resolve;
        reject = fail;
      },
    );
    const pending = monitorRuntimeFailures({
      store,
      now: () => "now",
      budgetMs: 77,
      deadline,
      observations: {
        process(_target, _component, cancellation) {
          signal = cancellation;
          started();
          return work;
        },
      },
    });
    await begun;
    expect(deadline.budgets).toEqual([77]);
    deadline.expire();
    expect(await pending).toEqual({ recorded: 0 });
    expect(signal.aborted).toBe(true);
    expect(deadline.pending).toBe(false);
    if (late === "rejection") reject(new Error("late rejection"));
    else complete({ state: "stopped", exitCode: 9 });
    await Promise.resolve();
    expect((await store.read()).activity).toEqual([]);
  });
}

for (const change of ["recovery", "generation"] as const) {
  test(`Activity rechecks racing ${change} after completed evidence`, async () => {
    const { store, state } = fixture();
    const deadline = controlledDeadline();
    expect(
      await monitorRuntimeFailures({
        store,
        now: () => "now",
        deadline,
        observations: {
          async process() {
            if (change === "recovery")
              state.targets[0]!.recovery = {
                plan: target.plan,
                desired: "running",
                stage: "pending",
              };
            else state.targets[0]!.updatedAt = "later";
            return { state: "stopped", exitCode: 5 };
          },
        },
      }),
    ).toEqual({ recorded: 0 });
    expect((await store.read()).activity).toEqual([]);
    expect(deadline.pending).toBe(false);
  });
}

for (const outcome of ["empty", "rejected", "completed"] as const) {
  test(`Activity ${outcome} releases scheduling and excludes store I/O from the budget`, async () => {
    const { store, state } = fixture();
    if (outcome === "empty") state.targets = [];
    const deadline = controlledDeadline();
    const checkedStore: StateStore = {
      async read() {
        expect(deadline.budgets).toEqual([]);
        return store.read();
      },
      async update(change) {
        expect(deadline.pending).toBe(false);
        await store.update(change);
      },
    };
    const result = await monitorRuntimeFailures({
      store: checkedStore,
      now: () => "now",
      deadline,
      observations: {
        process() {
          if (outcome === "rejected")
            throw new Error("synchronous provider failure");
          return Promise.resolve({ state: "stopped", exitCode: 5 });
        },
      },
    });
    expect(result).toEqual({ recorded: outcome === "completed" ? 1 : 0 });
    expect(deadline.pending).toBe(false);
    expect(deadline.budgets).toEqual(outcome === "empty" ? [] : [2000]);
  });
}

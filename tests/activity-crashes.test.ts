import { controlledDeadline } from "./controlled-observation-deadline";
import { expect, test } from "bun:test";
import type {
  RuntimeState,
  StateStore,
  TargetRecord,
} from "../src/domain/runtime";
import type { ProcessObservation } from "../src/providers/contracts";
import { timerObservationDeadline } from "../src/runtime/bounded-observations";
import { superviseTarget } from "../src/runtime/supervision";
const target = {
  id: "t",
  projectId: "p",
  name: "live",
  desired: "running",
  updatedAt: "2026-09-09T10:00:00Z",
  plan: {
    workspacePath: "/app",
    components: [{ kind: "managed", name: "web", restart: "no" }],
  },
  services: {
    web: {
      deployment: "/app",
      intent: "running",
      incarnation: "i1",
      attempts: [],
    },
  },
} as unknown as TargetRecord;
/** One supervision pass over the recorded Target with a scripted observation; the `no` policy keeps the lifecycle out of it. */
function fixture() {
  const state: RuntimeState = {
    version: 4,
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
  let id = 0;
  const pass = async (
    process: (
      target: TargetRecord,
      component: unknown,
      signal: AbortSignal,
    ) => Promise<ProcessObservation>,
    timing: {
      observationBudgetMs?: number;
      observationDeadline?: typeof timerObservationDeadline;
    } = {},
  ) =>
    superviseTarget((await store.read()).targets[0]!, {
      store,
      now: () => "2026-09-09T10:01:00Z",
      id: () => `id${++id}`,
      lifecycle: {
        async recover() {
          throw new Error("a no-policy Service is never started again");
        },
      } as never,
      observations: { process } as never,
      observationBudgetMs: 2000,
      observationDeadline: timerObservationDeadline,
      async diagnostic() {},
      ...timing,
    });
  return { state, store, pass };
}
test("a recorded exit becomes Activity once, however many passes see it, and names how the process ended", async () => {
  const { state, pass } = fixture();
  const crashed = async () =>
    ({ state: "stopped", incarnation: "i1", exitCode: 7 }) as const;
  await pass(crashed);
  await pass(crashed);
  expect(state.activity).toHaveLength(1);
  expect(state.activity[0]).toMatchObject({
    project: "app",
    target: "live",
    action: "crash",
    outcome: "failed",
    message: "web exited with code 7.",
  });
  expect(state.targets[0]!.services!.web!.outcome).toMatchObject({
    kind: "exited",
    exitCode: 7,
  });
});
for (const [name, observation, activity] of [
  [
    "a clean exit",
    { state: "stopped", incarnation: "i1", exitCode: 0 },
    { action: "exit", outcome: "stopped", message: "web exited with code 0." },
  ],
  [
    "a signal",
    { state: "stopped", incarnation: "i1", signal: "SIGKILL" },
    {
      action: "crash",
      outcome: "failed",
      message: "web was ended by SIGKILL.",
    },
  ],
  [
    "absence without exit evidence",
    { state: "stopped" },
    { action: "exit", outcome: "failed" },
  ],
  [
    "an exit record that names another start",
    { state: "stopped", incarnation: "i0", exitCode: 7 },
    { action: "exit", outcome: "failed" },
  ],
] as const)
  test(`${name} is told apart in Activity and never invented as a crash`, async () => {
    const { state, pass } = fixture();
    await pass(async () => observation);
    expect(state.activity).toHaveLength(1);
    expect(state.activity[0]).toMatchObject(activity);
    if (!("message" in activity)) {
      expect(state.activity[0]!.message).toContain("nothing recorded how");
      expect(state.targets[0]!.services!.web!.outcome).toMatchObject({
        kind: "unknown",
      });
    }
  });
test("a stop an operator asked for, a running process and an unknown observation record nothing", async () => {
  const { state, pass } = fixture();
  await pass(async () => ({ state: "running", pid: 9, incarnation: "i1" }));
  await pass(async () => ({ state: "unknown" }));
  state.targets[0]!.services!.web!.intent = "stopped";
  await pass(async () => ({
    state: "stopped",
    incarnation: "i1",
    signal: "SIGTERM",
  }));
  expect(state.activity).toEqual([]);
  expect(state.targets[0]!.services!.web!.outcome).toBeUndefined();
});

for (const late of ["resolution", "rejection"] as const) {
  test(`controlled expiry ignores late ${late} of the observation and cleans its deadline`, async () => {
    const { state, pass } = fixture();
    const deadline = controlledDeadline();
    let reject!: (error: Error) => void;
    let complete!: (value: ProcessObservation) => void;
    let signal!: AbortSignal;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const work = new Promise<ProcessObservation>((resolve, fail) => {
      complete = resolve;
      reject = fail;
    });
    const pending = pass(
      (_target, _component, cancellation) => {
        signal = cancellation;
        started();
        return work;
      },
      { observationBudgetMs: 77, observationDeadline: deadline },
    );
    await begun;
    expect(deadline.budgets).toEqual([77]);
    deadline.expire();
    expect(await pending).toBeUndefined();
    expect(signal.aborted).toBe(true);
    expect(deadline.pending).toBe(false);
    if (late === "rejection") reject(new Error("late rejection"));
    else complete({ state: "stopped", incarnation: "i1", exitCode: 9 });
    await Promise.resolve();
    expect(state.activity).toEqual([]);
    expect(state.targets[0]!.services!.web!.outcome).toBeUndefined();
  });
}

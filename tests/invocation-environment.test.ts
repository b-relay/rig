import { expect, test } from "bun:test";
import { referenceValuesOf } from "../src/adapters/invocation-environment";
import type {
  InstalledComponent,
  ManagedComponent,
  PlanJob,
  TargetPlan,
} from "../src/config/types";

const plan = (extra: Partial<TargetPlan> = {}): TargetPlan => ({
  project: "demo",
  target: "stable",
  workspacePath: "/ws",
  dataRoot: "/data",
  deploymentName: "stable",
  branchSlug: "stable",
  subdomain: "stable",
  providers: { processSupervisor: "rigd" },
  components: [],
  preparedComponents: [],
  referenceValues: {
    _RIG_A: "a",
    _RIG_B: "b",
    _RIG_C: "c",
    _RIG_D: "d",
    _RIG_E: "e",
  },
  builds: [
    { id: "shared", command: "build _RIG_A", timeout: 1 },
    {
      id: "service:web",
      component: "web",
      command: "build _RIG_B",
      timeout: 1,
    },
    { id: "tool:cli", component: "cli", command: "build _RIG_E", timeout: 1 },
  ],
  ...extra,
});
const web: ManagedComponent = {
  name: "web",
  kind: "managed",
  command: "serve _RIG_C",
  health: "check _RIG_D _RIG_MISSING",
  readyTimeout: 1,
  env: {},
  dependsOn: [],
};

test("the Project scope reads only the shared build's values", () => {
  expect(referenceValuesOf(plan())).toEqual({ _RIG_A: "a" });
});

test("a Service reads its build's, command's and health check's values, and no name the plan lacks", () => {
  expect(referenceValuesOf(plan(), web)).toEqual({
    _RIG_B: "b",
    _RIG_C: "c",
    _RIG_D: "d",
  });
});

test("a Tool reads its build's values", () => {
  const cli: InstalledComponent = {
    name: "cli",
    kind: "installed",
    entrypoint: "bin/cli",
    env: {},
    dependsOn: [],
  };
  expect(referenceValuesOf(plan(), cli)).toEqual({ _RIG_E: "e" });
});

test("a job reads its command's and restore's values, never a build's of the same name", () => {
  const job: PlanJob = {
    name: "web",
    command: "run _RIG_A",
    env: {},
    schedule: "* * * * *",
    backup: { keep: 1, restore: "restore _RIG_C" },
  };
  expect(referenceValuesOf(plan(), job)).toEqual({ _RIG_A: "a", _RIG_C: "c" });
});

test("a plan without reference values or builds gives none", () => {
  expect(
    referenceValuesOf(
      plan({ referenceValues: undefined, builds: undefined }),
      web,
    ),
  ).toEqual({});
});

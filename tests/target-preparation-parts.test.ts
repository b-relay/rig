import { expect, test } from "bun:test";
import { unitComponent } from "../src/adapters/target-preparation";
import { storageDirectory } from "../src/adapters/prepared-storage";
import type { PlanComponent, TargetPlan } from "../src/config/types";

const web: PlanComponent = {
  name: "web",
  kind: "managed",
  command: "serve",
  port: 3000,
  readyTimeout: 1,
  env: {},
  dependsOn: [],
};
const store: PlanComponent = {
  name: "db",
  kind: "persistent",
  uses: "sqlite",
  path: "/data/db.sqlite",
  env: {},
  dependsOn: [],
};
const plan = (extra: Partial<TargetPlan> = {}): TargetPlan => ({
  project: "demo",
  target: "stable",
  workspacePath: "/ws",
  dataRoot: "/data",
  deploymentName: "stable",
  branchSlug: "stable",
  subdomain: "stable",
  providers: { processSupervisor: "rigd" },
  components: [web, store],
  preparedComponents: [],
  ...extra,
});

test("a build unit runs in its Component's scope, the Project's for the shared unit or a store's", () => {
  expect(
    unitComponent(
      { id: "service:web", component: "web", command: "b", timeout: 1 },
      plan(),
    ),
  ).toBe(web);
  expect(
    unitComponent({ id: "shared", command: "b", timeout: 1 }, plan()),
  ).toBe(undefined);
  expect(
    unitComponent(
      { id: "store:db", component: "db", command: "b", timeout: 1 },
      plan(),
    ),
  ).toBe(undefined);
  expect(() =>
    unitComponent(
      { id: "service:ghost", component: "ghost", command: "b", timeout: 1 },
      plan(),
    ),
  ).toThrow(
    expect.objectContaining({
      code: "BUILD_SCOPE",
      message: "Build unit service:ghost names no Component of this plan.",
      details: { unit: "service:ghost" },
    }),
  );
});

test("prepared storage lives in the SQLite file's directory, the Convex state directory or the Postgres data directory", () => {
  expect(
    storageDirectory({
      name: "s",
      uses: "sqlite",
      path: "/data/db/app.sqlite",
    }),
  ).toBe("/data/db");
  expect(
    storageDirectory({ name: "c", uses: "convex", stateDir: "/data/convex" }),
  ).toBe("/data/convex");
  expect(
    storageDirectory({ name: "p", uses: "postgres", dataDir: "/data/pg" }),
  ).toBe("/data/pg");
});

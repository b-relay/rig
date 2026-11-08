import { expect, test } from "bun:test";
import type { ManagedComponent } from "../src/config/types";
import type { TargetRecord } from "../src/domain/runtime";
import { forceHint, unitLabel } from "../src/runtime/preparation-evidence";
import {
  exitDetails,
  exitedAfterReady,
  hasReadiness,
} from "../src/runtime/service-readiness";

const web: ManagedComponent = {
  name: "web",
  kind: "managed",
  command: "serve",
  readyTimeout: 1,
  env: {},
  dependsOn: [],
};
function target(kind: TargetRecord["kind"], name: string): TargetRecord {
  return {
    id: "t1",
    projectId: "p1",
    name,
    kind,
    ...(kind === "working" ? {} : { branch: "main" }),
    desired: "running",
    createdAt: "now",
    updatedAt: "now",
    logRoot: "/logs",
    plan: {
      project: "shop",
      target: kind,
      workspacePath: "/ws",
      dataRoot: "/data",
      deploymentName: name,
      branchSlug: name,
      subdomain: name,
      providers: { processSupervisor: "child" },
      preparedComponents: [],
      components: [web],
    },
  };
}

test("unitLabel names the shared build, or the build of the unit's Component", () => {
  expect(unitLabel({})).toBe("shared build");
  expect(unitLabel({ component: "api" })).toBe("api build");
});

test("forceHint sends a Working copy to restart and a Deployment to a forced deploy", () => {
  expect(forceHint(target("working", "working"))).toBe(
    "Run rig restart working --project shop to build it again.",
  );
  expect(forceHint(target("stable", "stable"))).toBe(
    "Run rig deploy stable --project shop --force to build a fresh Deployment; rig never reruns a build whose outcome it does not know.",
  );
});

test("hasReadiness: a healthcheck or a declared port is something to be ready on; neither leaves only being alive", () => {
  expect(hasReadiness(web)).toBe(false);
  expect(hasReadiness({ ...web, health: "http://127.0.0.1:4000/up" })).toBe(
    true,
  );
  expect(hasReadiness({ ...web, port: 4000 })).toBe(true);
  expect(hasReadiness({ ...web, ports: { http: 4000 } })).toBe(true);
  expect(hasReadiness({ ...web, ports: {} })).toBe(false);
});

test("exitDetails names the Service and only the exit evidence the observation holds", () => {
  expect(exitDetails("web", { state: "stopped" })).toEqual({
    component: "web",
  });
  expect(exitDetails("web", { state: "stopped", exitCode: 0 })).toEqual({
    component: "web",
    exitCode: 0,
  });
  expect(
    exitDetails("web", {
      state: "stopped",
      signal: "SIGKILL",
      pid: 9,
      incarnation: "i",
    }),
  ).toEqual({
    component: "web",
    signal: "SIGKILL",
  });
});

test("exitedAfterReady says the Service was ready, its exit code when known, and that nothing was published only when nothing was", () => {
  const stable = target("stable", "stable");
  const unpublished = exitedAfterReady(
    web,
    stable,
    { component: "web", exitCode: 3 },
    false,
  );
  expect(unpublished).toMatchObject({
    code: "PROCESS_EXITED",
    message:
      "web was ready, then exited with code 3 before stable finished starting.",
    hint: "Inspect the Target logs for why it ended; nothing of this start was published.",
    details: { component: "web", exitCode: 3 },
  });
  const published = exitedAfterReady(
    web,
    stable,
    { component: "web", signal: "SIGTERM" },
    true,
  );
  expect(published).toMatchObject({
    code: "PROCESS_EXITED",
    message: "web was ready, then exited before stable finished starting.",
    hint: "Inspect the Target logs for why it ended.",
    details: { component: "web", signal: "SIGTERM" },
  });
});

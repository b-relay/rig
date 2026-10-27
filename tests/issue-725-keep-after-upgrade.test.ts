import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeWorld } from "./support/runtime-world";
import { localActivation } from "./support/activation-doubles";
import type { HostSession } from "../src/domain/host-session";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import { parseProjectConfig } from "../src/config";
import { withValuesWritten } from "../src/config/plan-defaults";
import { serviceDefinition } from "../src/domain/service-definition";
import type { ManagedComponent, TargetPlan } from "../src/config/types";

/* Issue #725: a code-only deploy of melody's Stable Target restarted `db` (watch: [scripts/rig-postgres.sh]) and `search`
 * (watch: []). Modelled on melody: `db` and `search` read `${rig.data}` and `${port}` in their commands, `plain` watches
 * nothing and references nothing, and `api` compares the whole checkout. Each test deploys c1, then c2, where only files
 * outside db's watch list changed. Real runtime, lifecycle and state file under an isolated RIG_ROOT; scripted processes,
 * Host session and sources. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const config = parseProjectConfig({
  name: "melody",
  targets: { stable: true },
  services: {
    db: {
      command: "exec ./scripts/rig-postgres.sh ${rig.data} ${port}",
      ports: { pg: 5433 },
      watch: ["scripts/rig-postgres.sh"],
    },
    search: {
      command:
        'mkdir -p ${rig.data} && exec "$HOME/typesense-server" --data-dir ${rig.data} --api-port ${ports.http}',
      ports: { http: 8108 },
      watch: [],
    },
    plain: {
      command: 'exec "$HOME/plain-server"',
      ports: { http: 8200 },
      watch: [],
    },
    api: {
      command: "exec pnpm --filter @app/api start",
      ports: { http: 3401 },
      depends_on: ["db"],
    },
  },
});

async function fixture() {
  const processes = new Map<string, ProcessObservation>();
  let pid = 1000;
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      processes.set(request.key, {
        state: "running",
        pid: ++pid,
        incarnation: request.incarnation,
      });
      return { outcome: "started" };
    },
    async stop(key) {
      const running = processes.get(key)?.state === "running";
      processes.delete(key);
      return { outcome: running ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  const commit = { value: "c1" };
  const host: { session: HostSession } = {
    session: {
      boot: "BOOT-1",
      bootedAt: "2026-10-18T07:00:00.000Z",
      login: "100002",
    },
  };
  const world = await runtimeWorld({
    name: "issue-725",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-10-19T08:00:00.000Z",
    readinessDeadlineMs: 250,
    // Every process listens on every port of the plan, so each start check passes.
    activation: localActivation([5433, 8108, 8200, 3401]),
    dependencies: () => ({
      sources: {
        async preflight() {
          return { commit: commit.value, warnings: [] };
        },
        async prepare(request: { destination: string }) {
          await mkdir(request.destination, { recursive: true });
          return { workspacePath: request.destination, commit: commit.value };
        },
        async resolve() {
          return commit.value;
        },
        async currentBranch() {
          return "main";
        },
        async release() {},
        // Only files outside db's watch list changed between c1 and c2.
        async changed(request: { paths?: readonly string[] }) {
          return request.paths === undefined;
        },
        async unmatched() {
          return [];
        },
      },
      hostSession: {
        async current() {
          return { ...host.session };
        },
      },
    }),
  });
  roots.push(world.root);
  let runtime = world.open();
  await runtime.command({ action: "init", repoPath: world.repo });
  await runtime.reconcile();
  const statePath = join(world.root, "runtime", "state.json");
  return {
    commit,
    deploy: async () =>
      (await runtime.command({
        action: "deploy",
        project: "melody",
        target: "stable",
      })) as {
        kept: string[];
        restarted: { service: string; reason: string }[];
      },
    /** The Mac restarts: every process is gone, the boot is new, and the next rigd starts the Stable Target again. */
    async rebootAndRestore() {
      processes.clear();
      host.session = {
        boot: "BOOT-2",
        bootedAt: "2026-10-21T04:28:49.370Z",
        login: "100002",
      };
      runtime = world.open();
      await runtime.reconcile();
    },
    /** Rewrites the stored Stable Target as a rigd from before reference variables (1.0.0) recorded it from the same
     * rig.yaml: every value written into its commands, no `referenceValues` (see `withValuesWritten`). With `runs`, each
     * run's definition is the one that rigd took of that plan, as when 1.0.0 started the processes. */
    async recordAsBeforeReferenceVariables(runs: boolean) {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const target = state.targets.find(
        (t: { kind: string }) => t.kind === "stable",
      );
      const plan = withValuesWritten(target.plan as TargetPlan);
      target.plan = plan;
      if (runs)
        for (const component of plan.components)
          if (component.kind === "managed" && target.services[component.name])
            target.services[component.name].source.definition =
              serviceDefinition(plan, component as ManagedComponent);
      await writeFile(statePath, JSON.stringify(state));
      runtime = world.open();
    },
    async storedCommand(service: string) {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      return state.targets
        .find((t: { kind: string }) => t.kind === "stable")
        .plan.components.find((c: { name: string }) => c.name === service)
        .command as string;
    },
  };
}

test("control: a code-only deploy keeps db, search and plain", async () => {
  const f = await fixture();
  await f.deploy();
  f.commit.value = "c2";
  const second = await f.deploy();
  expect(second.kept).toEqual(["db", "search", "plain"]);
  expect(second.restarted).toEqual([{ service: "api", reason: "files" }]);
});

test("a code-only deploy after the Mac restarted and rigd started the Stable Target again keeps db, search and plain", async () => {
  const f = await fixture();
  await f.deploy();
  await f.rebootAndRestore();
  f.commit.value = "c2";
  const second = await f.deploy();
  expect(second.kept).toEqual(["db", "search", "plain"]);
  expect(second.restarted).toEqual([{ service: "api", reason: "files" }]);
});

test("#725: after an upgrade from a rigd before reference variables and a Mac restart, a code-only deploy keeps db and search, whose commands read ${rig.data} and ${port}", async () => {
  const f = await fixture();
  await f.deploy();
  // What 1.0.1 records and what 1.0.0 recorded for the same rig.yaml.
  expect(await f.storedCommand("search")).toContain("$_RIG_");
  await f.recordAsBeforeReferenceVariables(false);
  expect(await f.storedCommand("search")).not.toContain("_RIG_");
  // The Mac restarts; the 1.0.1 rigd starts the Target again from the plan 1.0.0 recorded.
  await f.rebootAndRestore();
  f.commit.value = "c2";
  const second = await f.deploy();
  // Fails at v1.0.1: kept is ["plain"], and db and search restart with reason "definition".
  expect(second.restarted).toEqual([{ service: "api", reason: "files" }]);
  expect(second.kept).toEqual(["db", "search", "plain"]);
});

test("#725 without a restart: the first code-only deploy after an upgrade from a rigd before reference variables keeps db and search", async () => {
  const f = await fixture();
  await f.deploy();
  await f.recordAsBeforeReferenceVariables(true);
  f.commit.value = "c2";
  const second = await f.deploy();
  // Fails at v1.0.1 the same way: the restart after the Mac restarted is not needed, only the upgrade.
  expect(second.restarted).toEqual([{ service: "api", reason: "files" }]);
  expect(second.kept).toEqual(["db", "search", "plain"]);
});

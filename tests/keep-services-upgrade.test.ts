import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeWorld } from "./support/runtime-world";
import { localActivation } from "./support/activation-doubles";
import type { HostSession } from "../src/domain/host-session";
import type { PreparedEnvironment } from "../src/domain/runtime";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import { parseProjectConfig } from "../src/config";
import { withValuesWritten } from "../src/config/plan-defaults";
import type { ProjectConfig, TargetPlan } from "../src/config/types";

/* ADR 0016 across a rigd upgrade. A rigd before reference variables (Rig 1.0.0) wrote every `${...}` value into a shell
 * command; a later one records `"$_RIG_..."` there and the values in the plan's `referenceValues`, which its commands get as
 * `_RIG_` variables. The same rig.yaml gives either plan, so a deploy that changes nothing a Service uses keeps it running
 * whichever rigd recorded its run, and still restarts it for a change. Modelled on melody: `db` and `search` read
 * `${rig.data}` and their ports, `search` has its own build, `indexer` reads db's port, `plain` reads nothing, and `api`
 * watches the whole checkout. Each deploy goes from c1 to c2, where only files outside db's watch list changed. Real
 * runtime, lifecycle and state file under an isolated RIG_ROOT; scripted processes, Host session and sources. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

function melody(): ProjectConfig {
  return parseProjectConfig({
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
        build: "true",
        ports: { http: 8108 },
        watch: [],
      },
      indexer: {
        command: 'exec "$HOME/indexer" --db-port ${services.db.port}',
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
}

async function fixture() {
  const config = melody();
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
    name: "keep-upgrade",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-10-19T08:00:00.000Z",
    readinessDeadlineMs: 250,
    // Every process listens on every port of the plan, db's moved one too, so each start check passes.
    activation: localActivation([5433, 5434, 8108, 8200, 3401]),
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
  const stored = async () => {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return {
      state,
      stable: state.targets.find((t: any) => t.kind === "stable"),
    };
  };
  return {
    config,
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
    /** The stored Stable Target as a rigd before reference variables recorded it from the same rig.yaml and Commit: every
     * value written into its commands, no `referenceValues`, and its preparation's digests taken of environments without
     * `_RIG_` variables. Then that rigd starts every Service from it, which records each run as it did. */
    async recordAsBeforeReferenceVariables() {
      const { state, stable } = await stored();
      stable.plan = withValuesWritten(stable.plan as TargetPlan);
      const preparation = stable.preparation;
      for (const prepared of [
        preparation,
        ...Object.values(preparation.units),
      ] as PreparedEnvironment[]) {
        prepared.environment =
          prepared.writtenEnvironment ?? prepared.environment;
        delete prepared.writtenEnvironment;
      }
      await writeFile(statePath, JSON.stringify(state));
      runtime = world.open();
      await runtime.command({
        action: "restart",
        project: "melody",
        target: "stable",
      });
    },
    /** The Mac restarts: every process is gone, the boot is new, and the next rigd starts the Stable Target again from the
     * plan it finds. */
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
    async storedCommand(service: string) {
      const { stable } = await stored();
      return stable.plan.components.find((c: any) => c.name === service)
        .command as string;
    },
    /** Each run's definition, environment and build digests, by Service. */
    async sources() {
      const { stable } = await stored();
      return Object.fromEntries(
        Object.entries(stable.services).map(([name, run]: [string, any]) => [
          name,
          run.source,
        ]),
      );
    },
  };
}

const unchanged = {
  kept: ["db", "search", "indexer", "plain"],
  restarted: [{ service: "api", reason: "files" }],
};

test("a code-only deploy keeps every Service that does not watch the change, whose commands read values or not", async () => {
  const f = await fixture();
  await f.deploy();
  // What today's rigd records: a variable in the command, the value beside it.
  expect(await f.storedCommand("search")).toContain('"$_RIG_');
  f.commit.value = "c2";
  expect(await f.deploy()).toMatchObject(unchanged);
});

test("the first code-only deploy after an upgrade from a rigd before reference variables keeps the Services it started", async () => {
  const f = await fixture();
  await f.deploy();
  await f.recordAsBeforeReferenceVariables();
  expect(await f.storedCommand("search")).not.toContain("_RIG_");
  f.commit.value = "c2";
  expect(await f.deploy()).toMatchObject(unchanged);
});

test("after an upgrade and a Mac restart, the Services today's rigd started again from the plan the earlier rigd recorded are kept", async () => {
  const f = await fixture();
  await f.deploy();
  await f.recordAsBeforeReferenceVariables();
  // The upgraded rigd starts the Target again from the plan the earlier one recorded.
  await f.rebootAndRestore();
  f.commit.value = "c2";
  expect(await f.deploy()).toMatchObject(unchanged);
});

test("a Service kept across the upgrade is kept again by the deploy after it", async () => {
  const f = await fixture();
  await f.deploy();
  await f.recordAsBeforeReferenceVariables();
  const before = await f.sources();
  f.commit.value = "c2";
  await f.deploy();
  // The kept runs still carry what the earlier rigd recorded.
  expect((await f.sources()).search).toEqual(before.search);
  f.commit.value = "c3";
  expect(await f.deploy()).toMatchObject(unchanged);
});

for (const recorded of ["today's rigd", "a rigd before reference variables"])
  test(`a changed value or command still restarts a Service whose run ${recorded} recorded`, async () => {
    const f = await fixture();
    await f.deploy();
    if (recorded !== "today's rigd") await f.recordAsBeforeReferenceVariables();
    f.commit.value = "c2";
    // db's port changes, which indexer only reads through its command; search's command changes.
    f.config.services!.db!.ports = { pg: 5434 };
    f.config.services!.search!.command += " --enable-cors";
    const result = await f.deploy();
    expect(result.kept).toEqual(["plain"]);
    expect(result.restarted).toEqual([
      { service: "db", reason: "definition" },
      { service: "search", reason: "definition" },
      {
        service: "indexer",
        // Today's definition holds the variable, and its value reaches the process as one.
        reason: recorded === "today's rigd" ? "environment" : "definition",
      },
      { service: "api", reason: "files" },
    ]);
  });

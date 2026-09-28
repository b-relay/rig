import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { runRigCli } from "../src/cli/rig";
import type { CliDependencies } from "../src/cli/types";
import type { RuntimeCommand } from "../src/daemon/protocol";
import { BUNDLED_RECIPES } from "../src/recipes/catalog";
import { compareRecipes } from "../src/recipes/compare";
import { renderRecipe } from "../src/recipes/render";
import { createRuntime } from "../src/runtime/application";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import { FileStateStore } from "../src/runtime/state-store";
import {
  findDeclaredFormat,
  parseProjectConfig,
  parseProjectDocument,
  projectModel,
  readProjectConfig,
  resolveTargetPlan,
  upgradeProjectConfig,
} from "../src/config/index.js";

const RESOLVE_HOST = { operatorHome: "/home/operator", envRoot: "/rig/env" };
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function project(yaml: string) {
  const root = await mkdtemp(join(tmpdir(), "rig-formats-"));
  roots.push(root);
  await writeFile(join(root, "rig.yaml"), yaml);
  return root;
}
const hintOf = (value: unknown) => {
  try {
    parseProjectConfig(value);
  } catch (error) {
    return (error as { hint: string }).hint;
  }
  return "";
};

/** A rig/v1 file that uses every place readiness can be spelled: Services, a role's Service patch, a reference to a
 * readiness setting, a timeout without a check, comments, flow style and quoting. */
const V1 = `# yaml-language-server: $schema=https://raw.githubusercontent.com/b-relay/rig/main/schemas/rig.schema.json
# The pantry app
name: pantry
services:
  api:
    run: bun run src/api.ts --port \${services.api.ports.http}
    ports: { http: auto }
    env:
      # Mirrors the start budget for the app's own warm-up.
      WARMUP: \${services.api.ready_timeout}
      PROBE: "\${ services.web.ready }"

    # Answers once migrations ran.
    ready: "http://127.0.0.1:\${services.api.ports.http}/health" # keep quoted
    ready_timeout: 1m
    depends_on: [db]
  web: { run: serve, ports: { http: 3000 }, ready: "http://127.0.0.1:\${services.web.ports.http}/" }
  db:
    run: exec postgres
    ports: { pg: auto }
    ready_timeout: 45s
targets:
  stable:
    services:
      api:
        ready_timeout: 2m # slower on the shared Host
  preview:
    services:
      web:
        ready: curl -fsS http://127.0.0.1:\${services.web.ports.http}/ready
`;
/** The same Project written by hand in rig/v2. */
const V2 = {
  format: "rig/v2",
  name: "pantry",
  services: {
    api: {
      run: "bun run src/api.ts --port ${services.api.ports.http}",
      ports: { http: "auto" },
      env: {
        WARMUP: "${services.api.health.start_timeout}",
        PROBE: "${ services.web.health.check }",
      },
      health: {
        check: "http://127.0.0.1:${services.api.ports.http}/health",
        start_timeout: "1m",
      },
      depends_on: ["db"],
    },
    web: {
      run: "serve",
      ports: { http: 3000 },
      health: { check: "http://127.0.0.1:${services.web.ports.http}/" },
    },
    db: {
      run: "exec postgres",
      ports: { pg: "auto" },
      health: { start_timeout: "45s" },
    },
  },
  targets: {
    stable: { services: { api: { health: { start_timeout: "2m" } } } },
    preview: {
      services: {
        web: {
          health: {
            check:
              "curl -fsS http://127.0.0.1:${services.web.ports.http}/ready",
          },
        },
      },
    },
  },
};
const plans = (config: ReturnType<typeof parseProjectConfig>) =>
  (["local", "live", "preview"] as const).map((target) =>
    resolveTargetPlan(
      {
        config,
        target,
        workspacePath: "/work",
        dataRoot: "/data",
        branch: "feature",
        assignedPorts: { "api.http": 47001, "web.http": 47002, "db.pg": 47003 },
      },
      RESOLVE_HOST,
    ),
  );

test("a rig/v1 file and the same Project in rig/v2 parse to one config, which has the rig/v2 shape and no format", async () => {
  const read = await readProjectConfig(await project(V1));
  expect(read.format).toBe("rig/v1");
  const v2 = parseProjectDocument(V2);
  expect(v2.format).toBe("rig/v2");
  const { format: _format, ...expected } = V2;
  expect(read.config as unknown).toEqual(expected);
  expect(v2.config).toEqual(read.config);
  // The parsed config reads back as itself, so a caller such as the planner may validate it again.
  expect(projectModel(read.config)).toEqual(read.config);
  // An explicit format: rig/v1 is the same as none.
  expect(
    parseProjectConfig({
      format: "rig/v1",
      name: "a",
      services: { w: { run: "x", ready: "true" } },
    }),
  ).toEqual({
    name: "a",
    services: { w: { run: "x", health: { check: "true" } } },
  });
});

test("the plans of a rig/v1 file are the plans of the same Project in rig/v2, in every role", async () => {
  const v1 = (await readProjectConfig(await project(V1))).config;
  const [local, live, preview] = plans(v1);
  expect(plans(parseProjectConfig(V2))).toEqual([local!, live!, preview!]);
  const api = (plan: typeof local) =>
    plan!.components.find((component) => component.name === "api");
  // The patch changes only the timeout; the check comes from the base Service.
  expect(api(live)).toMatchObject({
    readyTimeout: 120,
    health: "http://127.0.0.1:47001/health",
    env: { WARMUP: "2m", PROBE: "http://127.0.0.1:3000/" },
  });
  expect(api(local)).toMatchObject({ readyTimeout: 60 });
  // A timeout without a check still bounds the wait for the Service's ports.
  expect(local!.components.find((c) => c.name === "db")).toMatchObject({
    readyTimeout: 45,
  });
  expect(local!.components.find((c) => c.name === "db")).not.toHaveProperty(
    "health",
  );
  expect(preview!.components.find((c) => c.name === "web")).toMatchObject({
    health: "curl -fsS http://127.0.0.1:47002/ready",
  });
});

test("rig/v2 refuses ready and ready_timeout wherever a Service is spelled, naming where they moved", () => {
  const v2 = (
    service: Record<string, unknown>,
    patch?: Record<string, unknown>,
  ) => ({
    format: "rig/v2",
    name: "app",
    services: { web: { run: "serve", ...service } },
    ...(patch ? { targets: { stable: { services: { web: patch } } } } : {}),
  });
  expect(hintOf(v2({ ready: "true" }))).toBe(
    "Fix services.web.ready: rig/v2 moved ready to health.check.",
  );
  expect(hintOf(v2({ ready_timeout: "1m" }))).toBe(
    "Fix services.web.ready_timeout: rig/v2 moved ready_timeout to health.start_timeout.",
  );
  expect(hintOf(v2({}, { ready: "true" }))).toBe(
    "Fix targets.stable.services.web.ready: rig/v2 moved ready to health.check.",
  );
  expect(hintOf(v2({ health: { check: "true", start_timeout: "1m" } }))).toBe(
    "",
  );
});

test("rig/v1 refuses a health block with the way to upgrade, and an unknown format is refused", () => {
  expect(
    hintOf({
      name: "app",
      services: { web: { run: "serve", health: { check: "true" } } },
    }),
  ).toBe(
    "Fix services.web.health: health needs format: rig/v2; run rig config upgrade, which sets it and moves ready and ready_timeout into health.",
  );
  expect(
    hintOf({ format: "rig/v3", name: "app", services: { web: { run: "x" } } }),
  ).toBe(
    'Fix format: must be one of "rig/v1", "rig/v2"; a newer format needs a newer Rig.',
  );
});

test("rig config upgrade --dry-run prints the diff and writes nothing; the upgrade keeps comments and layout and means the same", async () => {
  const root = await project(V1);
  const file = join(root, "rig.yaml");
  const before = await readProjectConfig(root);

  const preview = await upgradeProjectConfig({ repoPath: root, dryRun: true });
  expect(preview).toMatchObject({
    from: "rig/v1",
    to: "rig/v2",
    written: false,
  });
  expect(await readFile(file, "utf8")).toBe(V1);
  expect(preview.diff).toContain("--- rig.yaml\n+++ rig.yaml\n");
  expect(preview.diff).toContain("-    ready_timeout: 1m\n");
  expect(preview.diff).toContain("+    health:\n");
  expect(preview.changes).toEqual([
    "format: rig/v2 (added; a file without it is rig/v1)",
    "services.api.env.WARMUP: ${services.api.ready_timeout} -> ${services.api.health.start_timeout}",
    "services.api.env.PROBE: ${ services.web.ready } -> ${ services.web.health.check }",
    "services.api.ready -> services.api.health.check",
    "services.api.ready_timeout -> services.api.health.start_timeout",
    "services.web.ready -> services.web.health.check",
    "services.db.ready_timeout -> services.db.health.start_timeout",
    "targets.stable.services.api.ready_timeout -> targets.stable.services.api.health.start_timeout",
    "targets.preview.services.web.ready -> targets.preview.services.web.health.check",
  ]);

  const upgraded = await upgradeProjectConfig({
    repoPath: root,
    dryRun: false,
  });
  expect(upgraded).toMatchObject({
    written: true,
    changes: preview.changes,
    diff: preview.diff,
  });
  expect(await readFile(`${file}.bak`, "utf8")).toBe(V1);
  expect(await readFile(file, "utf8"))
    .toBe(`# yaml-language-server: $schema=https://raw.githubusercontent.com/b-relay/rig/main/schemas/rig.schema.json
format: rig/v2
# The pantry app
name: pantry
services:
  api:
    run: bun run src/api.ts --port \${services.api.ports.http}
    ports: { http: auto }
    env:
      # Mirrors the start budget for the app's own warm-up.
      WARMUP: \${services.api.health.start_timeout}
      PROBE: "\${ services.web.health.check }"

    health:
      # Answers once migrations ran.
      check: "http://127.0.0.1:\${services.api.ports.http}/health" # keep quoted
      start_timeout: 1m
    depends_on: [db]
  web: { run: serve, ports: { http: 3000 }, health: { check: "http://127.0.0.1:\${services.web.ports.http}/" } }
  db:
    run: exec postgres
    ports: { pg: auto }
    health:
      start_timeout: 45s
targets:
  stable:
    services:
      api:
        health:
          start_timeout: 2m # slower on the shared Host
  preview:
    services:
      web:
        health:
          check: curl -fsS http://127.0.0.1:\${services.web.ports.http}/ready
`);
  const after = await readProjectConfig(root);
  expect(after.format).toBe("rig/v2");
  expect(after.config).toEqual(before.config);
  // No plan changes, so the upgrade alone is never config drift.
  expect(plans(after.config)).toEqual(plans(before.config));

  // A second run finds nothing to do and leaves the file alone.
  const again = await upgradeProjectConfig({ repoPath: root, dryRun: false });
  expect(again).toMatchObject({
    from: "rig/v2",
    changes: [],
    diff: "",
    written: false,
  });
  expect(await readFile(`${file}.bak`, "utf8")).toBe(V1);
});

test("an explicit format: rig/v1 is rewritten in place, and a file with nothing to move only gains its format", async () => {
  const root = await project(
    "name: tools\nformat: rig/v1\ntools:\n  ctl: { bin: bin/ctl }\n",
  );
  const upgraded = await upgradeProjectConfig({
    repoPath: root,
    dryRun: false,
  });
  expect(upgraded.changes).toEqual(["format: rig/v2 (was rig/v1)"]);
  expect(await readFile(join(root, "rig.yaml"), "utf8")).toBe(
    "name: tools\nformat: rig/v2\ntools:\n  ctl: { bin: bin/ctl }\n",
  );
  const bare = await project("name: tools\ntools:\n  ctl: { bin: bin/ctl }\n");
  await upgradeProjectConfig({ repoPath: bare, dryRun: false });
  expect(await readFile(join(bare, "rig.yaml"), "utf8")).toBe(
    "format: rig/v2\nname: tools\ntools:\n  ctl: { bin: bin/ctl }\n",
  );
});

/** The CLI over a real runtime and a real rig.yaml in `repo`; nothing is supervised, routed or installed. */
async function cliFixture(yaml: string) {
  const root = await mkdtemp(join(tmpdir(), "rig-formats-cli-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const file = join(repo, "rig.yaml");
  await writeFile(file, yaml);
  let id = 0;
  const deps = {
    root,
    async readAdminActivity() {
      return [];
    },
    async inspectHost() {
      return [];
    },
    async inspectProxy() {
      return {
        proxyFile: join(root, "Caddyfile"),
        routes: 0,
        state: "unpublished" as const,
      };
    },
    store: new FileStateStore(root),
    documents: {
      read: (path: string) => readProjectConfig(path),
      async discover(path: string) {
        return {
          repoPath: path,
          document: await readProjectConfig(path),
          gitRequired: false,
        };
      },
      async identifyInitialization(path: string) {
        return { repoPath: path, name: "pantry", configPath: file };
      },
      initialize: (path: string) => readProjectConfig(path),
      resolve: (input: Parameters<typeof resolveTargetPlan>[0]) =>
        resolveTargetPlan(input, RESOLVE_HOST),
      upgrade: (repoPath: string, options: { dryRun: boolean }) =>
        upgradeProjectConfig({ repoPath, ...options }),
      async host() {
        return {};
      },
    },
    files: {},
    now: () => "2026-09-28T00:00:00.000Z",
    id: () => `id${++id}`,
    async diagnostic() {},
  } as unknown as RuntimeDependencies;
  const runtime = createRuntime(deps);
  await runtime.command({ action: "init", repoPath: repo });
  return {
    file,
    repo,
    rig: (...args: string[]) =>
      cli(args, repo, (request) => runtime.command(request)),
  };
}
async function cli(
  args: string[],
  cwd: string,
  command: (request: RuntimeCommand) => Promise<unknown>,
  configFormat?: CliDependencies["configFormat"],
) {
  let out = "";
  let err = "";
  const code = await runRigCli(args, {
    root: "/isolated/.rig",
    cwd,
    ...(configFormat ? { configFormat } : {}),
    client: {
      async status() {
        throw new Error("status is not part of these tests");
      },
      command,
    },
    output: {
      write(value: string) {
        out += value;
      },
      error(value: string) {
        err += value;
      },
    },
    diagnostics: {
      async record() {
        return { path: "/isolated/.rig/logs/rig/rig.jsonl" };
      },
    },
    // A real pause: a mutation polls rigd while it waits, and must let file I/O run.
    wait: (ms) =>
      new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    newOperationId: () => "op-1",
  });
  return { code, out, err };
}

test("rig config upgrade --dry-run prints the diff and writes nothing; rig config upgrade rewrites the file and the deprecation line goes away", async () => {
  const f = await cliFixture(V1);
  const config = await f.rig("config");
  expect(config.code).toBe(0);
  expect(config.err).toBe(
    `Deprecated: ${f.file} is written in rig.yaml format rig/v1, which is deprecated. Run rig config upgrade to rewrite it as rig/v2, then commit it.\n`,
  );

  const dry = await f.rig("config", "upgrade", "--dry-run");
  expect(dry).toMatchObject({ code: 0, err: "" });
  expect(dry.out).toContain("--- rig.yaml\n+++ rig.yaml\n@@ ");
  expect(dry.out).toContain("-    ready_timeout: 1m\n");
  expect(dry.out).toContain(
    `Dry run: ${f.file} was not changed. It would move from rig/v1 to rig/v2:\n  format: rig/v2 (added; a file without it is rig/v1)\n`,
  );
  expect(await readFile(f.file, "utf8")).toBe(V1);

  const upgraded = await f.rig("config", "upgrade");
  expect(upgraded).toMatchObject({ code: 0, err: "" });
  expect(upgraded.out).toContain(
    `${f.file} upgraded from rig/v1 to rig/v2:\n  format: rig/v2 (added; a file without it is rig/v1)\n`,
  );
  expect(upgraded.out).toContain(
    "  targets.stable.services.api.ready_timeout -> targets.stable.services.api.health.start_timeout\n",
  );
  expect(upgraded.out).toContain(
    "Commit rig.yaml: deployed Targets read the committed file.\n",
  );
  expect(await readFile(f.file, "utf8")).toContain("format: rig/v2\n");
  // The previous text stays beside it.
  expect(await readFile(`${f.file}.bak`, "utf8")).toBe(V1);

  expect(await f.rig("config")).toMatchObject({ code: 0, err: "" });
  const again = await f.rig("config", "upgrade");
  expect(again.out).toBe(
    `${f.file} is already written in rig.yaml format rig/v2; nothing to change.\n`,
  );
});

test("rig config upgrade answers -h and --help, and rig config still takes no other argument", async () => {
  for (const flag of ["-h", "--help"]) {
    const help = await cli(["config", "upgrade", flag], "/workspace", () =>
      Promise.reject(new Error("help must not reach rigd")),
    );
    expect(help.code).toBe(0);
    expect(help.out).toContain("Usage: rig config upgrade [options]");
    expect(help.out).toContain("--dry-run");
  }
  const parent = await cli(["config", "--help"], "/workspace", () =>
    Promise.reject(new Error("help must not reach rigd")),
  );
  expect(parent.out).toContain("upgrade");
});

test("rig prints the deprecation line once per command, however many pages it follows", async () => {
  let pages = 0;
  const reply = {
    project: "pantry",
    target: "local",
    entries: [],
    cursor: "0",
    deprecation:
      "/repo/rig.yaml is written in rig.yaml format rig/v1, which is deprecated.",
  };
  const controller = new AbortController();
  let err = "";
  await runRigCli(["logs", "local", "--follow"], {
    root: "/isolated/.rig",
    cwd: "/repo",
    client: {
      async status() {
        throw new Error("unused");
      },
      async command() {
        if (++pages === 3) controller.abort();
        return reply;
      },
    },
    output: {
      write() {},
      error(value: string) {
        err += value;
      },
    },
    diagnostics: {
      async record() {
        return { path: "/isolated/.rig/logs/rig/rig.jsonl" };
      },
    },
    signal: controller.signal,
    wait: async () => {},
    newOperationId: () => "op-1",
  });
  expect(pages).toBe(3);
  expect(err).toBe(`Deprecated: ${reply.deprecation}\n`);
});

test("rig recipe generate writes the block in the format of the rig.yaml it is run beside, else the latest, or the one asked for", async () => {
  const v2 = await project(
    "format: rig/v2\nname: app\nservices:\n  web: { run: serve }\n",
  );
  const v1 = await project("name: app\nservices:\n  web: { run: serve }\n");
  const generate = (cwd: string, ...args: string[]) =>
    cli(
      ["recipe", "generate", "convex", ...args],
      cwd,
      () => Promise.reject(new Error("generate needs no rigd")),
      findDeclaredFormat,
    );
  const latest = (await generate(v2)).out;
  expect(latest).toContain(
    "    health:\n      check: http://127.0.0.1:${services.convex.ports.cloud}/instance_name\n      start_timeout: 60s\n",
  );
  expect(latest).not.toContain("ready");
  const older = (await generate(v1)).out;
  expect(older).toContain(
    "    ready: http://127.0.0.1:${services.convex.ports.cloud}/instance_name\n    ready_timeout: 60s\n",
  );
  expect(older).not.toContain("health");
  // Each block pastes into its own Project and parses there.
  for (const [root, block] of [
    [v2, latest],
    [v1, older],
  ] as const)
    expect(
      parseProjectConfig(
        parse(`${await readFile(join(root, "rig.yaml"), "utf8")}${block}`),
      ).services!.convex!.health!.start_timeout,
    ).toBe("60s");
  expect((await generate("/", "--format", "rig/v1")).out).toBe(older);
  expect((await generate(tmpdir())).out).toBe(latest);
  const refused = await generate(v2, "--format", "rig/v9");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("'rig/v9' is not a rig.yaml format.");
});

test("rig recipe diff names a changed field the way the Project's format spells it", async () => {
  const block = (format: "rig/v1" | "rig/v2") =>
    renderRecipe(
      BUNDLED_RECIPES.find((each) => each.name === "convex")!,
      BUNDLED_RECIPES.find((each) => each.name === "convex")!.versions[0]!,
      "convex",
      format,
    );
  for (const [format, path] of [
    ["rig/v1", "ready_timeout"],
    ["rig/v2", "health.start_timeout"],
  ] as const) {
    const yaml = `${format === "rig/v2" ? "format: rig/v2\n" : ""}name: app\nservices:\n${block(format).replace("60s", "90s")}`;
    const document = await readProjectConfig(await project(yaml));
    const [finding] = compareRecipes(document, BUNDLED_RECIPES);
    expect(finding).toMatchObject({
      status: "compared",
      customized: [{ path, from: "60s", to: "90s" }],
      update: [],
    });
  }
});

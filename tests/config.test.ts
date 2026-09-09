import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readProjectConfig,
  readProjectConfigSource,
} from "../src/config/index.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rig-config-"));
  roots.push(root);
  return root;
}
test("Project config reads YAML comments and returns its source and revision", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "rig.yaml"),
    "# Project\nname: pantry\ncomponents: {}\n",
  );
  const document = await readProjectConfig(root);
  expect(document.config.name).toBe("pantry");
  expect(document.format).toBe("yaml");
  expect(document.path).toBe(join(root, "rig.yaml"));
  expect(document.revision).toMatch(/^[a-f0-9]{64}$/);
});

test.each([
  ["yaml", "# Project\nname: pantry\ncomponents: {}\n"],
  ["json", '{"name":"pantry","components":{}}\n'],
])("%s config inspection and editing read the same revision and errors", async (format, raw) => {
  const root = await fixture();
  const path = join(root, `rig.${format}`);
  await writeFile(path, raw);
  const source = await readProjectConfigSource(root);
  const { raw: actual, ...document } = source;
  expect(actual).toBe(raw);
  expect(document).toEqual(await readProjectConfig(root));

  await writeFile(path, "{");
  const readError = await readProjectConfig(root).catch(
    (error: unknown) => error,
  );
  const sourceError = await readProjectConfigSource(root).catch(
    (error: unknown) => error,
  );
  expect(sourceError).toEqual(readError);
});

test("Target resolution provides forward component interpolation, environment inheritance, persistent paths, and dependency order", async () => {
  const { parseProjectConfig, resolveTargetPlan } =
    await import("../src/config/index.js");
  const config = parseProjectConfig({
    name: "pantry",
    components: {
      web: {
        mode: "managed",
        command: "serve --host 127.0.0.1 --port ${web.port} --db ${db.path}",
        dependsOn: ["db", "api"],
        env: { API: "${api.url}" },
      },
      api: { mode: "managed", command: "api --port ${api.port}" },
      db: { uses: "sqlite" },
    },
    local: {
      env: { MODE: "dev" },
      components: { web: { port: 5173 }, api: { port: 8081 } },
    },
  });
  const plan = resolveTargetPlan({
    config,
    target: "local",
    workspacePath: "/repo",
    dataRoot: "/state/data",
  });
  expect(plan.components.map((component) => component.name)).toEqual([
    "db",
    "api",
    "web",
  ]);
  expect(plan.components[2]).toMatchObject({
    command:
      "serve --host 127.0.0.1 --port 5173 --db /state/data/sqlite/db.sqlite",
    env: { MODE: "dev", API: "http://127.0.0.1:8081" },
    dependsOn: ["db", "api"],
  });
});

test("YAML restriction, ambiguity, JSON compatibility, and discovery policies agree", async () => {
  const { discoverProject, readHostConfig } =
    await import("../src/config/index.js");
  const { mkdir } = await import("node:fs/promises");
  const root = await fixture(),
    path = join(root, "rig.yaml");
  for (const raw of [
    "name: a\nname: b\ncomponents: {}",
    "name: &n a\ncomponents: {}",
    "name: !custom a\ncomponents: {}",
    "name: a\ncomponents: {}\n---\nname: b",
    "name: a\ncomponents: {<<: {}}",
    "name: *n\ncomponents: {}",
  ]) {
    await writeFile(path, raw);
    await expect(readProjectConfig(root)).rejects.toThrow();
  }
  await rm(path);
  await writeFile(
    join(root, "rig.json"),
    JSON.stringify({ name: "legacy", components: {} }),
  );
  expect((await readProjectConfig(root)).format).toBe("json");
  await mkdir(join(root, "nested"));
  expect((await discoverProject(join(root, "nested"))).repoPath).toBe(
    await realpath(root),
  );
  await writeFile(path, "name: ambiguous\ncomponents: {}");
  await expect(discoverProject(join(root, "nested"))).rejects.toThrow(
    "Both YAML and JSON",
  );
  expect((await readHostConfig(root)).diagnostics.retentionDays).toBe(14);
  await writeFile(
    join(root, "config.yaml"),
    "deploy:\n  productionBranch: release\n",
  );
  expect((await readHostConfig(root)).deploy.productionBranch).toBe("release");
  await writeFile(join(root, "config.json"), "{}");
  await expect(readHostConfig(root)).rejects.toThrow("Both YAML and JSON");
});

test("structured YAML edits retain comments/order and backups and reject stale or invalid updates", async () => {
  const { editProjectConfig } = await import("../src/config/index.js");
  const { readFile } = await import("node:fs/promises");
  const root = await fixture(),
    path = join(root, "rig.yaml"),
    original =
      "# Project\nname: pantry # identity\ncomponents: {} # capabilities\n";
  await writeFile(path, original);
  const before = await readProjectConfig(root);
  const after = await editProjectConfig({
    repoPath: root,
    expectedRevision: before.revision,
    edits: [{ path: ["name"], value: "food" }],
  });
  const raw = await readFile(path, "utf8");
  expect(raw).toContain("# Project");
  expect(raw).toContain("name: food # identity");
  expect(raw).toContain("components: {} # capabilities");
  expect(await readFile(after.backupPath, "utf8")).toBe(original);
  await expect(
    editProjectConfig({
      repoPath: root,
      expectedRevision: before.revision,
      edits: [],
    }),
  ).rejects.toThrow("changed");
  await expect(
    editProjectConfig({
      repoPath: root,
      expectedRevision: after.revision,
      edits: [{ path: ["name"], value: "../bad" }],
    }),
  ).rejects.toThrow("Invalid Project");
  expect(await readFile(path, "utf8")).toBe(raw);
});

test("validation rejects non-local bindings, invalid overrides, missing dependencies and cycles", async () => {
  const { parseProjectConfig } = await import("../src/config/index.js");
  for (const command of [
    "serve --host 0.0.0.0",
    "serve --bind=192.168.1.2",
    'serve --host "::"',
  ])
    expect(() =>
      parseProjectConfig({
        name: "app",
        components: { web: { mode: "managed", command } },
      }),
    ).toThrow();
  expect(() =>
    parseProjectConfig({
      name: "app",
      components: { tool: { mode: "installed", entrypoint: "run" } },
      local: { components: { tool: { port: 1 } } },
    }),
  ).toThrow();
  expect(() =>
    parseProjectConfig({
      name: "app",
      components: {
        a: { mode: "managed", command: "run", dependsOn: ["b"] },
        b: { mode: "managed", command: "run", dependsOn: ["a"] },
      },
    }),
  ).toThrow();
  expect(() =>
    parseProjectConfig({
      name: "app",
      components: {
        a: { mode: "managed", command: "run", dependsOn: ["missing"] },
      },
    }),
  ).toThrow();
});

test("Preview plans use assigned ports and bundled dependency defaults without losing lifecycle policy", async () => {
  const { parseProjectConfig, resolveTargetPlan } =
    await import("../src/config/index.js");
  const config = parseProjectConfig({
    name: "app",
    domain: "${subdomain}.example.com",
    hooks: { preStart: "echo ${workspace}" },
    components: {
      convex: { uses: "convex", port: 3210 },
      postgres: { uses: "postgres", port: 5432 },
      tool: {
        mode: "installed",
        entrypoint: "bin/tool",
        build: "bun build",
        installName: "example",
      },
    },
    deployments: {
      subdomain: "${branchSlug}",
      providers: { processSupervisor: "launchd" },
      proxy: { upstream: "convex" },
    },
  });
  const plan = resolveTargetPlan({
    config,
    target: "preview",
    branch: "feature/test",
    commit: "abc",
    workspacePath: "/work",
    dataRoot: "/data",
    assignedPorts: { convex: 4000, "convex.site": 4001, postgres: 5433 },
  });
  expect(plan).toMatchObject({
    domain: "feature-test.example.com",
    branch: "feature/test",
    commit: "abc",
    providers: { processSupervisor: "launchd" },
    hooks: { preStart: "echo /work" },
  });
  expect(plan.components[0]).toMatchObject({
    port: 4000,
    sitePort: 4001,
    health: "http://127.0.0.1:4000/instance_name",
  });
  expect(plan.components[1]).toMatchObject({
    port: 5433,
    health: "pg_isready -h 127.0.0.1 -p 5433",
  });
  expect(plan.components[2]).toMatchObject({
    kind: "installed",
    entrypoint: "/work/bin/tool",
    installName: "example",
  });
  expect(() =>
    resolveTargetPlan({
      config,
      target: "preview",
      workspacePath: "/work",
      dataRoot: "/data",
      assignedPorts: { convex: 5432, postgres: 5432 },
    }),
  ).toThrow("more than one");
});

test("existing full-stack JSON fixture resolves every local Component without migration", async () => {
  const { resolveTargetPlan } = await import("../src/config/index.js");
  const document = await readProjectConfig(
    join(import.meta.dir, "../fixtures/rig-projects/fullstack-basic"),
  );
  const plan = resolveTargetPlan({
    config: document.config,
    target: "local",
    workspacePath: "/work",
    dataRoot: "/data",
  });
  expect(plan.components.map((component) => component.name)).toEqual([
    "db",
    "postgres",
    "convex",
    "api",
    "web",
  ]);
  expect(plan.components[3]).toMatchObject({
    health: "http://127.0.0.1:8081/health",
  });
});

test("Target override environment augments shared Component environment", async () => {
  const { parseProjectConfig, resolveTargetPlan } =
    await import("../src/config/index.js");
  const config = parseProjectConfig({
    name: "app",
    components: {
      web: {
        mode: "managed",
        command: "run",
        port: 3210,
        env: { A: "shared", B: "shared" },
      },
    },
    local: {
      env: { C: "lane" },
      components: { web: { env: { B: "override" } } },
    },
  });
  expect(
    resolveTargetPlan({
      config,
      target: "local",
      workspacePath: "/work",
      dataRoot: "/data",
    }).components[0]!.env,
  ).toEqual({ A: "shared", B: "override", C: "lane" });
});

test("Project init creates YAML with requested managed, installed, dependency and route policy", async () => {
  const { initializeProjectConfig } = await import("../src/config/index.js");
  const root = await fixture();
  const document = await initializeProjectConfig(root, {
    name: "app",
    productionBranch: "release",
    domain: "app.example.com",
    proxy: "web",
    uses: ["sqlite"],
    managed: { name: "web", command: "serve --host localhost", port: 3210 },
    installed: { name: "tool", entrypoint: "bin/tool" },
  });
  expect(document.config).toMatchObject({
    name: "app",
    domain: "app.example.com",
    components: {
      sqlite: { uses: "sqlite" },
      web: { mode: "managed", port: 3210 },
      tool: { mode: "installed", entrypoint: "bin/tool" },
    },
    live: { deployBranch: "release", proxy: { upstream: "web" } },
  });
  await expect(
    initializeProjectConfig(root, { name: "other" }),
  ).rejects.toThrow("already exists");
});

test("YAML editing refuses replacing a mapping when nested comments would be lost", async () => {
  const { editProjectConfig } = await import("../src/config/index.js");
  const { readFile } = await import("node:fs/promises");
  const root = await fixture(),
    raw = "name: app\ncomponents:\n  # retain me\n  db:\n    uses: sqlite\n";
  await writeFile(join(root, "rig.yaml"), raw);
  const document = await readProjectConfig(root);
  await expect(
    editProjectConfig({
      repoPath: root,
      expectedRevision: document.revision,
      edits: [{ path: ["components"], value: {} }],
    }),
  ).rejects.toThrow("mapping");
  expect(await readFile(join(root, "rig.yaml"), "utf8")).toBe(raw);
});

test("YAML 1.1 directives are rejected instead of changing scalar meaning", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "rig.yaml"),
    "%YAML 1.1\n---\nname: app\ncomponents: {}\n",
  );
  await expect(readProjectConfig(root)).rejects.toThrow("YAML 1.2");
});

test("structured editing preserves an unrelated existing temporary file", async () => {
  const { editProjectConfig } = await import("../src/config/index.js");
  const { readFile } = await import("node:fs/promises");
  const root = await fixture(),
    path = join(root, "rig.yaml");
  await writeFile(path, "name: app\ncomponents: {}\n");
  await writeFile(`${path}.tmp`, "unrelated temporary content");
  const document = await readProjectConfig(root);
  await editProjectConfig({
    repoPath: root,
    expectedRevision: document.revision,
    edits: [{ path: ["name"], value: "renamed" }],
  });
  expect(await readFile(`${path}.tmp`, "utf8")).toBe(
    "unrelated temporary content",
  );
});

test("global hooks retain Target environment independently of Component overrides", async () => {
  const { parseProjectConfig, resolveTargetPlan } =
    await import("../src/config/index.js");
  const config = parseProjectConfig({
    name: "app",
    hooks: { preStart: "prepare" },
    components: {
      web: {
        mode: "managed",
        command: "run",
        port: 3210,
        env: { MODE: "component" },
      },
    },
    local: { env: { MODE: "target", URL: "${web.url}" } },
  });
  const plan = resolveTargetPlan({
    config,
    target: "local",
    workspacePath: "/work",
    dataRoot: "/data",
  });
  expect(plan.env).toEqual({ MODE: "target", URL: "http://127.0.0.1:3210" });
  expect(plan.components[0]!.env.MODE).toBe("component");
});

test("interpolation rejects inherited object properties as unknown names", async () => {
  const { parseProjectConfig, resolveTargetPlan } =
    await import("../src/config/index.js");
  for (const key of ["constructor", "__proto__", "toString"]) {
    const config = parseProjectConfig({
      name: "app",
      components: {
        web: { mode: "managed", command: "run ${" + key + "}", port: 3210 },
      },
    });
    expect(() =>
      resolveTargetPlan({
        config,
        target: "local",
        workspacePath: "/work",
        dataRoot: "/data",
      }),
    ).toThrow("Unknown interpolation");
  }
});

test("invalid config errors carry bounded safe field guidance and source path through transport message and hint", async () => {
  const root = await fixture(),
    path = join(root, "rig.json");
  await writeFile(
    path,
    JSON.stringify({
      name: "app",
      components: {
        web: {
          mode: "managed",
          command: "run",
          port: 0,
          env: { SECRET: "do-not-expose-this-value" },
        },
      },
    }),
  );
  try {
    await readProjectConfig(root);
    throw new Error("expected validation failure");
  } catch (error) {
    const safe = error as { message: string; hint: string };
    expect(safe.hint).toContain("components.web.port");
    expect(safe.hint).toContain(path);
    expect(safe.hint.length).toBeLessThan(1200);
    expect(safe.message + safe.hint).not.toContain("do-not-expose-this-value");
  }
});

test("dependency and override lookup never treats inherited object names as Components", async () => {
  const { parseProjectConfig } = await import("../src/config/index.js");
  expect(() =>
    parseProjectConfig({
      name: "app",
      components: {
        web: { mode: "managed", command: "run", dependsOn: ["constructor"] },
      },
    }),
  ).toThrow("Invalid Project");
  expect(() =>
    parseProjectConfig({
      name: "app",
      components: {},
      local: { components: { constructor: { port: 3210 } } },
    }),
  ).toThrow("Invalid Project");
});

test.each([
  ["relative/work", "/data", "workspacePath"],
  ["/work", "relative/data", "dataRoot"],
  ["relative/work", "relative/data", "workspacePath"],
  ["", "/data", "workspacePath"],
])("Target resolution rejects unsupported roots %s and %s before policy calculation", async (workspacePath, dataRoot, field) => {
  const { resolveTargetPlan, parseProjectConfig } = await import("../src/config/index.js");
  const config = parseProjectConfig({ name: "app", components: {} });
  // An invalid interpolation would fail if plan calculation started first.
  expect(() => resolveTargetPlan({ config, target: "local", workspacePath, dataRoot, subdomain: "${unknown}" })).toThrow(
    expect.objectContaining({ _tag: "ConfigError", code: "relative_root", context: { field }, hint: expect.stringContaining("absolute") }),
  );
});

test("complete accepted plans are independent of process cwd with portable paths and Unicode roots", async () => {
  const { parseProjectConfig, resolveTargetPlan } = await import("../src/config/index.js");
  const { mkdir } = await import("node:fs/promises");
  const root = await fixture();
  const cwdA = join(root, "cwd one"), cwdB = join(root, "cwd 二");
  await Promise.all([mkdir(cwdA), mkdir(cwdB)]);
  const input = {
    config: parseProjectConfig({
      name: "app",
      hooks: { preStart: "echo ${workspace}" },
      components: {
        tool: { mode: "installed", entrypoint: "bin/工具", envFile: "env/tool.env" },
        web: { mode: "managed", command: "serve --port ${web.port} --db ${db.path}", dependsOn: ["db", "pg"], env: { DATA: "${dataRoot}", URL: "${web.url}" } },
        db: { uses: "sqlite", path: "relative/数据库.sqlite" },
        stored: { uses: "sqlite" },
        pg: { uses: "postgres" },
      },
      deployments: { envFile: "env/${target}.env", env: { ROOT: "${workspace}" } },
    }),
    target: "preview" as const,
    workspacePath: "/work space/项目",
    dataRoot: "/persistent space/数据",
    branch: "feature/test",
    commit: "abc",
    assignedPorts: { web: 4100, pg: 5433 },
  };
  const script = `import { resolveTargetPlan } from ${JSON.stringify(join(import.meta.dir, "../src/config/index.ts"))}; process.stdout.write(JSON.stringify(resolveTargetPlan(${JSON.stringify(input)})));`;
  const plans = await Promise.all([cwdA, cwdB].map(async (cwd) => {
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd, env: { ...process.env, RIG_ROOT: join(cwd, ".rig") }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return JSON.parse(stdout);
  }));
  const plan = resolveTargetPlan(input);
  expect(plans[0]).toEqual(plans[1]);
  expect(plans[0]).toEqual(JSON.parse(JSON.stringify(plan)));
  expect(plan.components.map((component) => component.name)).toEqual(["tool", "db", "pg", "web", "stored"]);
  expect(plan.envFile).toBe("/work space/项目/env/preview.env");
  expect(plan.components[0]).toMatchObject({ entrypoint: "/work space/项目/bin/工具", envFile: "/work space/项目/env/tool.env" });
  expect(plan.components[3]).toMatchObject({ port: 4100, command: "serve --port 4100 --db /work space/项目/relative/数据库.sqlite", env: { DATA: "/persistent space/数据", URL: "http://127.0.0.1:4100" } });
  expect(plan.preparedComponents).toEqual([
    { name: "pg", uses: "postgres", dataDir: "/persistent space/数据/postgres/pg" },
    { name: "db", uses: "sqlite", path: "/work space/项目/relative/数据库.sqlite" },
    { name: "stored", uses: "sqlite", path: "/persistent space/数据/sqlite/stored.sqlite" },
  ]);
});

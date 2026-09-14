import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseProjectConfig,
  readProjectConfig,
  readProjectConfigSource,
  resolveTargetPlan,
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
])(
  "%s config inspection and editing read the same revision and errors",
  async (format, raw) => {
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
  },
);

test("a registered directory that no longer exists is told apart from a directory without a config", async () => {
  const root = await fixture();
  await expect(readProjectConfig(root)).rejects.toMatchObject({
    code: "missing_config",
  });
  const gone = join(root, "moved-away");
  await expect(readProjectConfig(gone)).rejects.toMatchObject({
    code: "missing_directory",
    message: `Project directory ${gone} does not exist.`,
    context: { repoPath: gone },
  });
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
      assignedPorts: { convex: 5432, "convex.site": 5433, postgres: 5432 },
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
    domain: "${subdomain}.app.example.com",
    components: {
      sqlite: { uses: "sqlite" },
      web: { mode: "managed", port: 3210 },
      tool: { mode: "installed", entrypoint: "bin/tool" },
    },
    live: {
      deployBranch: "release",
      domain: "app.example.com",
      proxy: { upstream: "web" },
    },
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
])(
  "Target resolution rejects unsupported roots %s and %s before policy calculation",
  async (workspacePath, dataRoot, field) => {
    const { resolveTargetPlan, parseProjectConfig } =
      await import("../src/config/index.js");
    const config = parseProjectConfig({ name: "app", components: {} });
    // An invalid interpolation would fail if plan calculation started first.
    expect(() =>
      resolveTargetPlan({
        config,
        target: "local",
        workspacePath,
        dataRoot,
        subdomain: "${unknown}",
      }),
    ).toThrow(
      expect.objectContaining({
        _tag: "ConfigError",
        code: "relative_root",
        context: { field },
        hint: expect.stringContaining("absolute"),
      }),
    );
  },
);

test("complete accepted plans are independent of process cwd with portable paths and Unicode roots", async () => {
  const { parseProjectConfig, resolveTargetPlan } =
    await import("../src/config/index.js");
  const { mkdir } = await import("node:fs/promises");
  const root = await fixture();
  const cwdA = join(root, "cwd one"),
    cwdB = join(root, "cwd 二");
  await Promise.all([mkdir(cwdA), mkdir(cwdB)]);
  const input = {
    config: parseProjectConfig({
      name: "app",
      hooks: { preStart: "echo ${workspace}" },
      components: {
        tool: {
          mode: "installed",
          entrypoint: "bin/工具",
          envFile: "env/tool.env",
        },
        web: {
          mode: "managed",
          command: "serve --port ${web.port} --db ${db.path}",
          dependsOn: ["db", "pg"],
          env: { DATA: "${dataRoot}", URL: "${web.url}" },
        },
        db: { uses: "sqlite", path: "relative/数据库.sqlite" },
        stored: { uses: "sqlite" },
        pg: { uses: "postgres" },
      },
      deployments: {
        envFile: "env/${target}.env",
        env: { ROOT: "${workspace}" },
      },
    }),
    target: "preview" as const,
    workspacePath: "/work space/项目",
    dataRoot: "/persistent space/数据",
    branch: "feature/test",
    commit: "abc",
    assignedPorts: { web: 4100, pg: 5433 },
  };
  const script = `import { resolveTargetPlan } from ${JSON.stringify(join(import.meta.dir, "../src/config/index.ts"))}; process.stdout.write(JSON.stringify(resolveTargetPlan(${JSON.stringify(input)})));`;
  const plans = await Promise.all(
    [cwdA, cwdB].map(async (cwd) => {
      const child = Bun.spawn([process.execPath, "--eval", script], {
        cwd,
        env: { ...process.env, RIG_ROOT: join(cwd, ".rig") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      return JSON.parse(stdout);
    }),
  );
  const plan = resolveTargetPlan(input);
  expect(plans[0]).toEqual(plans[1]);
  expect(plans[0]).toEqual(JSON.parse(JSON.stringify(plan)));
  expect(plan.components.map((component) => component.name)).toEqual([
    "tool",
    "db",
    "pg",
    "web",
    "stored",
  ]);
  expect(plan.envFile).toBe("/work space/项目/env/preview.env");
  expect(plan.components[0]).toMatchObject({
    entrypoint: "/work space/项目/bin/工具",
    envFile: "/work space/项目/env/tool.env",
  });
  expect(plan.components[3]).toMatchObject({
    port: 4100,
    command:
      "serve --port 4100 --db '/persistent space/数据/relative/数据库.sqlite'",
    env: { DATA: "/persistent space/数据", URL: "http://127.0.0.1:4100" },
  });
  expect(plan.preparedComponents).toEqual([
    {
      name: "pg",
      uses: "postgres",
      dataDir: "/persistent space/数据/postgres/pg",
    },
    {
      name: "db",
      uses: "sqlite",
      path: "/persistent space/数据/relative/数据库.sqlite",
    },
    {
      name: "stored",
      uses: "sqlite",
      path: "/persistent space/数据/sqlite/stored.sqlite",
    },
  ]);
});

test.each([
  ["serve --addr 127.0.0.1:${server.port}", "serve --addr 127.0.0.1:3210"],
  ["serve --addr=localhost:${server.port}", "serve --addr=localhost:3210"],
  ['serve --addr "localhost:${server.port}"', 'serve --addr "localhost:3210"'],
  ["serve --addr 127.0.0.1:3210", "serve --addr 127.0.0.1:3210"],
])(
  "Target resolution accepts localhost port binding %s",
  async (command, expected) => {
    const { parseProjectConfig, resolveTargetPlan } =
      await import("../src/config/index.js");
    const config = parseProjectConfig({
      name: "share",
      components: { server: { mode: "managed", command, port: 3210 } },
    });
    const plan = resolveTargetPlan({
      config,
      target: "local",
      workspacePath: "/repo",
      dataRoot: "/state/data",
    });
    expect(plan.components[0]).toMatchObject({ command: expected });
  },
);

test.each([
  "serve --addr 0.0.0.0:${server.port}",
  "serve --addr=192.168.1.2:${server.port}",
  'serve --addr "[::]:${server.port}"',
  "serve --addr ${server.port}:3210",
  'sh -c "node s.js --host 0.0.0.0"',
  "sh -c 'node s.js --host 0.0.0.0'",
  'sh -c "node s.js --host ::"',
  'bash -c "exec node s.js --bind 192.168.1.2 --port ${server.port}"',
  "sh -c 'sh -c \"serve --listen 0.0.0.0\"'",
])("raw config rejects non-local binding %s", async (command) => {
  const { parseProjectConfig } = await import("../src/config/index.js");
  expect(() =>
    parseProjectConfig({
      name: "share",
      components: { server: { mode: "managed", command, port: 3210 } },
    }),
  ).toThrow("Invalid Project configuration");
});

test("Target resolution validates actual interpolated bind values", async () => {
  const { parseProjectConfig, resolveTargetPlan } =
    await import("../src/config/index.js");
  const config = parseProjectConfig({
    name: "share",
    components: {
      server: {
        mode: "managed",
        command: "serve --addr 127.0.0.1:${db.path}",
        port: 3210,
      },
      db: { uses: "sqlite" },
    },
  });
  expect(() =>
    resolveTargetPlan({
      config,
      target: "local",
      workspacePath: "/repo",
      dataRoot: "/state/data",
    }),
  ).toThrow("Resolved command binds outside localhost");
});

test("an unknown process supervisor is rejected at parse time with the valid choices", async () => {
  const { parseProjectConfig } = await import("../src/config/index.js");
  const parse = () =>
    parseProjectConfig({
      name: "app",
      components: { web: { mode: "managed", command: "serve", port: 4000 } },
      live: { providers: { processSupervisor: "launchdd" } },
    });
  let failure: unknown;
  try {
    parse();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    code: "invalid_config",
    hint: expect.stringMatching(
      /live\.providers\.processSupervisor:.*"rigd".*"child".*"launchd"/,
    ),
  });
  for (const processSupervisor of ["rigd", "child", "launchd"] as const)
    expect(
      parseProjectConfig({
        name: "app",
        components: {},
        live: { providers: { processSupervisor } },
      }).live?.providers?.processSupervisor,
    ).toBe(processSupervisor);
});
test("paths interpolated into shell commands, hooks, health checks, and builds are shell-quoted unless the author already quoted them", async () => {
  const { parseProjectConfig, resolveTargetPlan } =
    await import("../src/config/index.js");
  const config = parseProjectConfig({
    name: "spaced",
    hooks: {
      preStart: "cd ${workspace} && bun install",
      postStop: 'echo "${workspace}"',
    },
    components: {
      web: {
        mode: "managed",
        command:
          "node ${workspace}/server.js --db ${db.path} --port ${web.port}",
        health: "test -f ${workspace}/ready",
        dependsOn: ["db"],
        env: { DB: "${db.path}" },
      },
      api: {
        mode: "managed",
        command: "node '${workspace}/api.js' --port ${api.port}",
        health: "http://127.0.0.1:${api.port}/",
      },
      tool: {
        mode: "installed",
        entrypoint: "bin/tool",
        build: "bun build ${workspace}/src/tool.ts",
      },
      db: { uses: "sqlite" },
    },
    local: { components: { web: { port: 4000 }, api: { port: 4001 } } },
  });
  const plan = resolveTargetPlan({
    config,
    target: "local",
    workspacePath: "/repos/my app",
    dataRoot: "/state/it's data",
    assignedPorts: { web: 4000, api: 4001 },
  });
  const web = plan.components.find((component) => component.name === "web")!;
  expect(web).toMatchObject({
    command: `node '/repos/my app'/server.js --db '/state/it'\\''s data/sqlite/db.sqlite' --port 4000`,
    health: "test -f '/repos/my app'/ready",
    env: { DB: "/state/it's data/sqlite/db.sqlite" },
  });
  expect(
    plan.components.find((component) => component.name === "api"),
  ).toMatchObject({
    command: "node '/repos/my app/api.js' --port 4001",
    health: "http://127.0.0.1:4001/",
  });
  expect(
    plan.components.find((component) => component.name === "tool"),
  ).toMatchObject({
    build: "bun build '/repos/my app'/src/tool.ts",
  });
  expect(plan.hooks).toMatchObject({
    preStart: "cd '/repos/my app' && bun install",
    postStop: 'echo "/repos/my app"',
  });
  const printed = Bun.spawnSync([
    "/bin/sh",
    "-c",
    `printf '%s\\n' ${web.kind === "managed" ? web.command.replace(/^node /, "") : ""}`,
  ]).stdout.toString();
  expect(printed.split("\n").filter(Boolean)).toEqual([
    "/repos/my app/server.js",
    "--db",
    "/state/it's data/sqlite/db.sqlite",
    "--port",
    "4000",
  ]);
});

test("a runtime-selected Convex site port is honoured for local and live instead of being replaced by port + 1", () => {
  const config = parseProjectConfig({
    name: "demo",
    components: { api: { uses: "convex", port: 4568 } },
  });
  for (const target of ["local", "live"] as const) {
    const plan = resolveTargetPlan({
      config,
      target,
      workspacePath: "/tmp/w",
      dataRoot: "/tmp/d",
      deploymentName: target,
      assignedPorts: { api: 4568, "api.site": 5000 },
    });
    expect(
      plan.components.find((component) => component.name === "api"),
    ).toMatchObject({ port: 4568, sitePort: 5000 });
  }
});

test("hooks are rejected on Components without a process, in the base definition and in lane overrides", async () => {
  const hooks = { preStart: "echo before" };
  const config = (extra: Record<string, unknown>) => ({
    name: "app",
    components: {
      tool: { mode: "installed", entrypoint: "run" },
      db: { uses: "sqlite" },
      web: { mode: "managed", command: "serve", hooks },
    },
    ...extra,
  });
  expect(() => parseProjectConfig(config({}))).not.toThrow();
  const rejection = (value: unknown) => {
    try {
      parseProjectConfig(value);
    } catch (error) {
      return (error as { hint?: string }).hint ?? "";
    }
    return "";
  };
  expect(
    rejection({
      ...config({}),
      components: {
        ...config({}).components,
        tool: { mode: "installed", entrypoint: "run", hooks },
      },
    }),
  ).toContain(
    "base.components.tool.hooks: Hooks run around a Component's process",
  );
  expect(
    rejection(config({ live: { components: { tool: { hooks } } } })),
  ).toContain(
    "live.components.tool.hooks: Hooks run around a Component's process",
  );
  expect(() =>
    parseProjectConfig(config({ local: { components: { db: { hooks } } } })),
  ).toThrow();
});

test.each([
  [
    "preview",
    { db: { uses: "sqlite", path: "/tmp/elsewhere/db.sqlite" } },
    {},
    { component: "db", field: "path" },
    "/tmp/elsewhere/db.sqlite",
  ],
  [
    "live",
    { db: { uses: "sqlite", path: "../escape.sqlite" } },
    {},
    { component: "db", field: "path" },
    "/escape.sqlite",
  ],
  [
    "preview",
    { db: { uses: "sqlite", path: "${workspace}/db.sqlite" } },
    {},
    { component: "db", field: "path" },
    "/work/db.sqlite",
  ],
  [
    "live",
    {
      web: {
        mode: "managed",
        command: "serve --port ${web.port}",
        envFile: "/etc/app.env",
      },
    },
    {},
    { component: "web", field: "envFile" },
    "/etc/app.env",
  ],
  [
    "preview",
    { web: { mode: "managed", command: "serve --port ${web.port}" } },
    { envFile: "../shared/.env" },
    { field: "envFile" },
    "/shared/.env",
  ],
])(
  "%s Targets reject a sqlite path or envFile that resolves outside the Target's storage, naming the field",
  async (target, components, lane, context, path) => {
    const config = parseProjectConfig({
      name: "app",
      components,
      ...(target === "live" ? { live: lane } : { deployments: lane }),
    });
    expect(() =>
      resolveTargetPlan({
        config,
        target: target as "live" | "preview",
        workspacePath: "/work",
        dataRoot: "/data",
        branch: "main",
        commit: "abc",
        assignedPorts: { web: 4100 },
      }),
    ).toThrow(
      expect.objectContaining({
        _tag: "ConfigError",
        code: "path_outside_target",
        context: {
          ...context,
          path,
          root: context.field === "path" ? "/data" : "/work",
        },
        hint: expect.stringContaining(context.field),
      }),
    );
  },
);

test("local Targets keep the developer's absolute sqlite path and envFile", () => {
  const config = parseProjectConfig({
    name: "app",
    components: {
      db: { uses: "sqlite", path: "/tmp/elsewhere/db.sqlite" },
      web: {
        mode: "managed",
        command: "serve --port ${web.port}",
        envFile: "/etc/app.env",
      },
    },
  });
  const plan = resolveTargetPlan({
    config,
    target: "local",
    workspacePath: "/work",
    dataRoot: "/data",
    assignedPorts: { web: 4100 },
  });
  expect(plan.preparedComponents).toEqual([
    { name: "db", uses: "sqlite", path: "/tmp/elsewhere/db.sqlite" },
  ]);
  expect(
    plan.components.find((component) => component.name === "web"),
  ).toMatchObject({ envFile: "/etc/app.env" });
});

test.each([
  ["hooks.postStart", { hooks: { postStart: "node proxy.js --host 0.0.0.0" } }],
  [
    "components.web.hooks.preStart",
    {
      components: {
        web: {
          mode: "managed",
          command: "serve",
          hooks: { preStart: 'sh -c "tunnel --listen 0.0.0.0:9000"' },
        },
      },
    },
  ],
  [
    "components.web.env.HOST",
    {
      components: {
        web: { mode: "managed", command: "serve", env: { HOST: "0.0.0.0" } },
      },
    },
  ],
  [
    "deployments.env.BIND_ADDR",
    {
      components: { web: { mode: "managed", command: "serve" } },
      deployments: { env: { BIND_ADDR: "[::]:3000" } },
    },
  ],
])(
  "hooks and bind-style env values are held to the localhost rule at %s",
  (path, extra) => {
    let hint = "";
    try {
      parseProjectConfig({
        name: "app",
        components: { web: { mode: "managed", command: "serve" } },
        ...extra,
      });
    } catch (error) {
      hint = (error as { hint: string }).hint;
    }
    expect(hint).toContain(`${path}: `);
    expect(hint).toMatch(/localhost/);
  },
);

test("env values that are not wildcard bindings are accepted, and a wrapped localhost command passes", () => {
  const config = parseProjectConfig({
    name: "app",
    components: {
      web: {
        mode: "managed",
        command: 'sh -c "node s.js --host 127.0.0.1 --port ${web.port}"',
        env: {
          HOST: "app.example.com",
          HOSTNAME: "mac.local",
          PUBLIC_URL: "http://0.0.0.0.nip.io",
        },
        hooks: { postStart: "curl -s http://localhost:${web.port}/warm" },
      },
    },
  });
  expect(config.components.web).toMatchObject({
    env: { HOST: "app.example.com" },
  });
});

test.each([
  "http://127.0.0.1'@evil.com/health",
  'http://127.0.0.1"@evil.com/health',
  "HTTP://10.0.0.1/health",
  "http://user:secret@127.0.0.1/health",
  "https://127.0.0.1.nip.io/health",
])(
  "health URLs are parsed whole and case-insensitively, so %s is rejected",
  (health) => {
    let hint = "";
    try {
      parseProjectConfig({
        name: "app",
        components: { web: { mode: "managed", command: "serve", health } },
      });
    } catch (error) {
      hint = (error as { hint: string }).hint;
    }
    expect(hint).toContain("components.web.health: ");
    expect(hint).toMatch(/127\.0\.0\.1 or localhost/);
  },
);

test.each([
  "http://127.0.0.1:4000/?next=http://example.com",
  "HTTP://LOCALHOST:${web.port}/health",
  "curl -fsS http://example.com/ping",
])("health value %s is accepted", (health) => {
  const config = parseProjectConfig({
    name: "app",
    components: { web: { mode: "managed", command: "serve", health } },
  });
  expect(config.components.web).toMatchObject({ health });
});

test("Target resolution validates interpolated health values like commands", () => {
  const config = parseProjectConfig({
    name: "share",
    components: {
      server: {
        mode: "managed",
        command: "serve",
        health: "probe --addr 127.0.0.1:${db.path}",
        port: 3210,
      },
      db: { uses: "sqlite" },
    },
  });
  expect(() =>
    resolveTargetPlan({
      config,
      target: "local",
      workspacePath: "/repo",
      dataRoot: "/state/data",
    }),
  ).toThrow(
    expect.objectContaining({
      _tag: "ConfigError",
      code: "invalid_binding",
      context: { component: "server", field: "health" },
    }),
  );
});

test("a lane Component override merges hooks per key like env, so adding one hook keeps the shared ones", () => {
  const config = parseProjectConfig({
    name: "app",
    components: {
      web: {
        mode: "managed",
        command: "serve",
        env: { A: "shared" },
        hooks: { preStart: "echo pre", preStop: "echo stop" },
      },
    },
    local: {
      components: {
        web: {
          env: { B: "local" },
          hooks: { postStart: "echo post", preStop: "echo local-stop" },
        },
      },
    },
  });
  const plan = resolveTargetPlan({
    config,
    target: "local",
    workspacePath: "/work",
    dataRoot: "/data",
    assignedPorts: { web: 4100 },
  });
  expect(plan.components[0]).toMatchObject({
    env: { A: "shared", B: "local" },
    hooks: {
      preStart: "echo pre",
      postStart: "echo post",
      preStop: "echo local-stop",
    },
  });
});

test("rig init --domain scaffolds a distinct hostname for local, live, and every Preview", async () => {
  const { scaffoldProjectConfig } = await import("../src/config/documents.js");
  const config = scaffoldProjectConfig({
    name: "app",
    domain: "app.test",
    proxy: "web",
    managed: { name: "web", command: "serve --port ${web.port}", port: 3000 },
  });
  const hostname = (target: "local" | "live" | "preview", branch?: string) =>
    resolveTargetPlan({
      config,
      target,
      workspacePath: "/work",
      dataRoot: "/data",
      assignedPorts: { web: 4100 },
      ...(branch ? { branch, commit: "abc" } : {}),
    }).domain;
  expect([
    hostname("local"),
    hostname("live"),
    hostname("preview", "feature/x"),
  ]).toEqual(["local.app.test", "app.test", "feature-x.app.test"]);
});

test("editing a Project whose rig.yaml is a symlink writes through to the linked document and keeps the link", async () => {
  const { editProjectConfig } = await import("../src/config/index.js");
  const base = await fixture();
  const shared = join(base, "shared"),
    repo = join(base, "repo");
  await Promise.all([mkdir(shared), mkdir(repo)]);
  await writeFile(join(shared, "rig.yaml"), "name: demo\ncomponents: {}\n");
  await symlink(join(shared, "rig.yaml"), join(repo, "rig.yaml"));
  const document = await readProjectConfig(repo);
  const result = await editProjectConfig({
    repoPath: repo,
    expectedRevision: document.revision,
    edits: [{ path: ["description"], value: "edited" }],
  });
  expect((await lstat(join(repo, "rig.yaml"))).isSymbolicLink()).toBe(true);
  expect(await readFile(join(shared, "rig.yaml"), "utf8")).toContain("edited");
  expect(
    result.backupPath.startsWith(await realpath(join(shared, "rig.yaml"))),
  ).toBe(true);
  expect(await readFile(result.backupPath, "utf8")).toBe(
    "name: demo\ncomponents: {}\n",
  );
});
test("a config lock left by a crashed edit is reclaimed; one held by a live process is refused by path", async () => {
  const { editProjectConfig } = await import("../src/config/index.js");
  const { utimes } = await import("node:fs/promises");
  const root = await fixture(),
    path = join(root, "rig.yaml");
  await writeFile(path, "name: pantry\ncomponents: {}\n");
  const lock = `${await realpath(path)}.lock`;
  const edit = async () =>
    editProjectConfig({
      repoPath: root,
      expectedRevision: (await readProjectConfig(root)).revision,
      edits: [],
    });
  // A lock with no readable holder that is older than a minute belongs to a dead edit.
  await writeFile(lock, "");
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);
  await edit();
  await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  // So does one whose recorded pid has exited.
  await writeFile(lock, JSON.stringify({ pid: 2147483647 }));
  await edit();
  // A fresh unreadable lock, or one whose holder is alive, is refused with the path.
  await writeFile(lock, "");
  const fresh = await edit().catch((error) => error);
  expect(fresh).toMatchObject({ code: "config_locked" });
  expect(fresh.hint).toContain(lock);
  await writeFile(lock, JSON.stringify({ pid: process.pid }));
  const held = await edit().catch((error) => error);
  expect(held).toMatchObject({
    code: "config_locked",
    context: { lockPath: lock, pid: process.pid },
  });
  expect(held.hint).toContain(`held by pid ${process.pid}`);
  expect(await readFile(lock, "utf8")).toBe(
    JSON.stringify({ pid: process.pid }),
  );
});

test("hook, build and dependency-install budgets are declared in seconds and resolve into the Target plan", () => {
  const config = parseProjectConfig({
    name: "budgets",
    hookTimeout: 30,
    installTimeout: 900,
    components: {
      web: { mode: "managed", command: "serve", port: 4000, hookTimeout: 45 },
      tool: {
        mode: "installed",
        entrypoint: "tool",
        build: "make",
        buildTimeout: 1200,
      },
    },
    live: { components: { tool: { buildTimeout: 1800 } } },
  });
  const plan = resolveTargetPlan({
    config,
    target: "live",
    workspacePath: "/work",
    dataRoot: "/data",
    assignedPorts: { web: 4000 },
  });
  expect(plan).toMatchObject({ hookTimeout: 30, installTimeout: 900 });
  expect(plan.components).toMatchObject([
    { name: "web", hookTimeout: 45 },
    { name: "tool", buildTimeout: 1800 },
  ]);
  expect(() =>
    parseProjectConfig({
      name: "budgets",
      components: {
        web: { mode: "managed", command: "serve", port: 4000, hookTimeout: 0 },
      },
    }),
  ).toThrow();
});

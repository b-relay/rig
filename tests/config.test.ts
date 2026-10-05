import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  discoverProject,
  editProjectConfig,
  initializeProjectConfig,
  parseProjectConfig,
  patchedSettings,
  previewProjectConfig,
  readHostConfig,
  readProjectConfig,
  readProjectConfigSource,
  resolveTargetPlan as resolvePlanWithHost,
  scaffoldProjectConfig,
  targetOn,
  TARGET_ROLES,
} from "../src/config/index.js";
import { referenceResolver } from "../src/config/references";
const RESOLVE_HOST = { operatorHome: "/home/operator", envRoot: "/rig/env" };
/** The operator's optional convention files for one scope, in precedence order. */
const conventionFiles = (role: string, ...scope: string[]) =>
  ["all", role].map((file) => ({
    path: ["/rig/env", ...scope, `${file}.env`].join("/"),
    required: false,
  }));
const resolveTargetPlan = (input: Parameters<typeof resolvePlanWithHost>[0]) =>
  resolvePlanWithHost(input, RESOLVE_HOST);
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
/** The smallest valid Project document: one Service with one pinned port. */
const MINIMAL = "name: pantry\nservices:\n  web:\n    command: serve\n";
const web = (extra: Record<string, unknown> = {}) => ({
  web: { command: "serve", ports: { http: 3000 }, ...extra },
});
/** The ConfigError a parse raised, or undefined when the input was accepted. */
function failureOf(input: unknown):
  | {
      code: string;
      hint: string;
      message: string;
      context: { issues?: { path: string[]; message: string }[] };
    }
  | undefined {
  try {
    parseProjectConfig(input);
  } catch (error) {
    return error as NonNullable<ReturnType<typeof failureOf>>;
  }
  return undefined;
}
const hintOf = (input: unknown) => failureOf(input)?.hint ?? "";
const issuePaths = (input: unknown) =>
  (failureOf(input)?.context.issues ?? []).map((issue) => issue.path.join("."));
const roots_ = { workspacePath: "/work", dataRoot: "/data" };

// ---------------------------------------------------------------------------
// Documents: reading, discovery, retired formats
// ---------------------------------------------------------------------------

test("Project config reads YAML comments and returns its path and revision", async () => {
  const root = await fixture();
  await writeFile(join(root, "rig.yaml"), `# Project\n${MINIMAL}`);
  const document = await readProjectConfig(root);
  expect(document.config.name).toBe("pantry");
  expect(document.path).toBe(join(root, "rig.yaml"));
  expect(document.revision).toMatch(/^[a-f0-9]{64}$/);
});

test("config inspection and editing read the same revision and errors", async () => {
  const root = await fixture();
  const path = join(root, "rig.yaml"),
    raw = `# Project\n${MINIMAL}`;
  await writeFile(path, raw);
  const { raw: actual, ...document } = await readProjectConfigSource(root);
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

test("malformed YAML is a ConfigError that names the document path", async () => {
  const root = await fixture(),
    path = join(root, "rig.yaml");
  await writeFile(path, "name: app\nservices:\n  web: [unclosed\n");
  const failure = await readProjectConfig(root).catch(
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({
    _tag: "ConfigError",
    code: "invalid_yaml",
    context: { path },
    hint: expect.stringContaining(path),
  });
});

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

test.each([
  ["duplicate keys", `name: a\n${MINIMAL}`, "invalid_yaml"],
  ["anchors", MINIMAL.replace("pantry", "&n pantry"), "invalid_yaml"],
  [
    "explicit tags",
    MINIMAL.replace("pantry", "!custom pantry"),
    "invalid_yaml",
  ],
  ["several documents", `${MINIMAL}---\nname: b\n`, "invalid_yaml"],
  [
    "merge keys",
    "name: a\nservices:\n  web: {<<: {}, command: serve}\n",
    "invalid_yaml",
  ],
  ["aliases", MINIMAL.replace("pantry", "*n"), "invalid_yaml"],
])("restricted YAML refuses %s", async (_label, raw, code) => {
  const root = await fixture();
  await writeFile(join(root, "rig.yaml"), raw);
  await expect(readProjectConfig(root)).rejects.toMatchObject({ code });
});

test("YAML 1.1 directives are rejected instead of changing scalar meaning", async () => {
  const root = await fixture();
  await writeFile(join(root, "rig.yaml"), `%YAML 1.1\n---\n${MINIMAL}`);
  await expect(readProjectConfig(root)).rejects.toThrow("YAML 1.2");
});

test("discovery searches upward and never falls through a nearer invalid or retired document", async () => {
  const root = await fixture();
  await writeFile(join(root, "rig.yaml"), MINIMAL);
  await mkdir(join(root, "nested", "deeper"), { recursive: true });
  const found = await discoverProject(join(root, "nested", "deeper"));
  expect(found.repoPath).toBe(await realpath(root));
  expect(found.document.config.name).toBe("pantry");

  await writeFile(join(root, "nested", "rig.yaml"), "name: nearer\n");
  await expect(
    discoverProject(join(root, "nested", "deeper")),
  ).rejects.toMatchObject({ code: "invalid_config" });
});

test("Host config reads config.yaml and defaults when absent", async () => {
  const root = await fixture();
  expect((await readHostConfig(root)).diagnostics.retention_days).toBe(14);
  await writeFile(
    join(root, "config.yaml"),
    "deploy:\n  production_branch: release\n",
  );
  expect((await readHostConfig(root)).deploy.production_branch).toBe("release");
});

// ---------------------------------------------------------------------------
// Scaffold and init
// ---------------------------------------------------------------------------

test("scaffold writes a Service, a Tool, or both, and refuses a Project with neither", () => {
  const service = {
    name: "web",
    command: "serve --host localhost",
    port: 3210,
  };
  const tool = { name: "ctl", bin: "bin/ctl", build: "make ctl" };
  const names = { working: true, stable: false, preview: false };
  expect(
    scaffoldProjectConfig({
      name: "app",
      productionBranch: "release",
      domain: "app.example.com",
      service: { ...service, ready: "http://127.0.0.1:3210/health" },
      tool,
    }),
  ).toEqual({
    name: "app",
    production_branch: "release",
    domain: "app.example.com",
    services: {
      web: {
        command: "serve --host localhost",
        ports: { http: 3210 },
        ready: "http://127.0.0.1:3210/health",
      },
    },
    tools: { ctl: { build: "make ctl", bin: "bin/ctl" } },
    // The one Service with one port serves the domain without a proxy.
    targets: names,
  });
  // Without a domain there is nothing to route; without a port Rig chooses one.
  expect(
    scaffoldProjectConfig({
      name: "app",
      service: { name: "web", command: "serve" },
    }),
  ).toEqual({
    name: "app",
    production_branch: "main",
    services: { web: { command: "serve", ports: { http: "auto" } } },
    targets: names,
  });
  // A Tool-only Project never gets a proxy, even when a domain is given.
  expect(
    scaffoldProjectConfig({
      name: "app",
      domain: "app.test",
      tool: { name: "ctl", bin: "bin/ctl" },
    }),
  ).toEqual({
    name: "app",
    production_branch: "main",
    domain: "app.test",
    tools: { ctl: { bin: "bin/ctl" } },
    targets: names,
  });
  expect(() => scaffoldProjectConfig({ name: "app" })).toThrow(
    expect.objectContaining({
      _tag: "ConfigError",
      code: "empty_project",
      hint: expect.stringContaining("--service"),
    }),
  );
});

test("Project init writes the scaffold as YAML once and leaves an existing document untouched", async () => {
  const root = await fixture();
  const config = scaffoldProjectConfig({
    name: "app",
    domain: "app.example.com",
    service: { name: "web", command: "serve", port: 3210 },
  });
  const document = await initializeProjectConfig(root, config);
  expect(document.path).toBe(join(root, "rig.yaml"));
  expect(document.config).toEqual(config);
  const raw = await readFile(document.path, "utf8");
  // The first line points an editor's YAML language server at the published Project schema.
  expect(raw.split("\n")[0]).toBe(
    "# yaml-language-server: $schema=https://raw.githubusercontent.com/b-relay/rig/main/schemas/rig.schema.json",
  );
  expect(parse(raw)).toEqual(config);
  expect(await readProjectConfig(root)).toEqual(document);
  await expect(
    initializeProjectConfig(
      root,
      scaffoldProjectConfig({
        name: "other",
        tool: { name: "t", bin: "bin/t" },
      }),
    ),
  ).rejects.toMatchObject({ code: "already_initialized" });
  expect(await readFile(document.path, "utf8")).toBe(raw);
});

test("a scaffolded domain gives the stable Target the hostname, every Preview a flat one beside it, and the working Target none", () => {
  const config = scaffoldProjectConfig({
    name: "app",
    domain: "app.test",
    service: { name: "web", command: "serve", port: 3000 },
  });
  const plan = (
    target: "working" | "stable" | "preview",
    deploymentName?: string,
  ) =>
    resolveTargetPlan({
      config,
      target,
      ...roots_,
      assignedPorts: { web: 4100 },
      ...(deploymentName ? { deploymentName } : {}),
    });
  expect(plan("working").domain).toBeUndefined();
  expect(plan("working").proxy).toBeUndefined();
  expect(plan("stable")).toMatchObject({
    domain: "app.test",
    proxy: { upstream: "web" },
  });
  expect(plan("preview", "feature-x-0a1b2c3d").domain).toBe(
    "app-feature-x-0a1b2c3d.test",
  );
});

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

test("a rig-recipe comment left by an older Rig is only a comment: the config reads and plans as before, and an edit keeps it", async () => {
  const root = await fixture(),
    path = join(root, "rig.yaml"),
    original = [
      "name: pantry",
      "services:",
      "  # rig-recipe: postgres@1 name=db",
      "  db:",
      "    command: postgres",
      "    ports: { pg: auto }",
      "  # rig-recipe: not a form any Rig wrote",
      "  web:",
      "    command: serve",
      "",
    ].join("\n");
  await writeFile(path, original);
  const before = await readProjectConfig(root);
  expect(Object.keys(before.config.services ?? {})).toEqual(["db", "web"]);
  const plan = resolveTargetPlan({
    config: before.config,
    target: "working",
    ...roots_,
    assignedPorts: { db: 5544 },
  });
  expect(JSON.stringify(plan)).not.toContain("rig-recipe");
  await editProjectConfig({
    repoPath: root,
    expectedRevision: before.revision,
    edits: [{ path: ["services", "web", "command"], value: "serve --port 1" }],
  });
  expect(await readFile(path, "utf8")).toBe(
    original.replace("command: serve\n", "command: serve --port 1\n"),
  );
});

test("structured YAML edits retain comments/order and backups and reject stale or invalid updates", async () => {
  const root = await fixture(),
    path = join(root, "rig.yaml"),
    original =
      "# Project\nname: pantry # identity\nservices:\n  # processes\n  web:\n    command: serve # command\n";
  await writeFile(path, original);
  const before = await readProjectConfig(root);
  const preview = await previewProjectConfig({
    repoPath: root,
    expectedRevision: before.revision,
    edits: [{ path: ["name"], value: "food" }],
  });
  expect(preview.config.name).toBe("food");
  expect(await readFile(path, "utf8")).toBe(original);
  expect(await readdir(root)).toEqual(["rig.yaml"]);

  const after = await editProjectConfig({
    repoPath: root,
    expectedRevision: before.revision,
    edits: [
      { path: ["name"], value: "food" },
      { path: ["services", "web", "command"], value: "serve --port 1" },
    ],
  });
  const raw = await readFile(path, "utf8");
  expect(raw).toBe(
    original
      .replace("pantry", "food")
      .replace("command: serve #", "command: serve --port 1 #"),
  );
  expect(after).toMatchObject({
    raw,
    baseRevision: before.revision,
  });
  expect(after.revision).toBe((await readProjectConfig(root)).revision);
  expect(await readFile(after.backupPath, "utf8")).toBe(original);
  await expect(
    editProjectConfig({
      repoPath: root,
      expectedRevision: before.revision,
      edits: [],
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  await expect(
    editProjectConfig({
      repoPath: root,
      expectedRevision: after.revision,
      edits: [{ path: ["name"], value: "../bad" }],
    }),
  ).rejects.toThrow("Invalid Project");
  await expect(
    editProjectConfig({
      repoPath: root,
      expectedRevision: after.revision,
      edits: [{ path: ["services", "__proto__", "command"], value: "x" }],
    }),
  ).rejects.toMatchObject({ code: "invalid_edit" });
  expect(await readFile(path, "utf8")).toBe(raw);
});

test("YAML editing refuses edits that would lose comments: replacing a mapping or removing a commented field", async () => {
  const root = await fixture(),
    raw =
      "name: app\nservices:\n  # retain me\n  web:\n    command: serve\n    ready: curl localhost # why\n";
  await writeFile(join(root, "rig.yaml"), raw);
  const document = await readProjectConfig(root);
  for (const edit of [
    { path: ["services"], value: {} },
    { op: "remove" as const, path: ["services", "web", "ready"] },
  ]) {
    const failure = await editProjectConfig({
      repoPath: root,
      expectedRevision: document.revision,
      edits: [edit],
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ _tag: "ConfigError", code: "lossy_edit" });
  }
  expect(await readFile(join(root, "rig.yaml"), "utf8")).toBe(raw);
  expect(await readdir(root)).toEqual(["rig.yaml"]);
});

test("structured editing preserves an unrelated existing temporary file", async () => {
  const root = await fixture(),
    path = join(root, "rig.yaml");
  await writeFile(path, MINIMAL);
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

test("editing a Project whose rig.yaml is a symlink writes through to the linked document and keeps the link", async () => {
  const base = await fixture();
  const shared = join(base, "shared"),
    repo = join(base, "repo");
  await Promise.all([mkdir(shared), mkdir(repo)]);
  await writeFile(join(shared, "rig.yaml"), MINIMAL);
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
  expect(await readFile(result.backupPath, "utf8")).toBe(MINIMAL);
});

test("a config lock left by a crashed edit is reclaimed; one held by a live process is refused by path", async () => {
  const root = await fixture(),
    path = join(root, "rig.yaml");
  await writeFile(path, MINIMAL);
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

test("config edits keep one .bak beside the file, holding the text before the latest edit", async () => {
  const root = await fixture(),
    path = join(root, "rig.yaml");
  await writeFile(path, MINIMAL);
  const first = await editProjectConfig({
    repoPath: root,
    expectedRevision: (await readProjectConfig(root)).revision,
    edits: [{ path: ["name"], value: "food" }],
  });
  const second = await editProjectConfig({
    repoPath: root,
    expectedRevision: first.revision,
    edits: [{ path: ["name"], value: "drink" }],
  });
  expect(second.backupPath).toBe(`${await realpath(path)}.bak`);
  expect(first.backupPath).toBe(second.backupPath);
  expect(await readFile(second.backupPath, "utf8")).toBe(first.raw);
  expect(
    (await readdir(root)).filter((entry) => entry.includes("bak")),
  ).toEqual(["rig.yaml.bak"]);
});

// ---------------------------------------------------------------------------
// Schema: shape, Target names, patches, proxy
// ---------------------------------------------------------------------------

test.each(["service", "tool", "multi"])(
  "the accepted %s example parses as written",
  async (example) => {
    const raw = await readFile(
      join(import.meta.dir, `../docs/examples/${example}.rig.yaml`),
      "utf8",
    );
    const root = await fixture();
    await writeFile(join(root, "rig.yaml"), raw);
    const { config } = await readProjectConfig(root);
    // Nothing is defaulted, dropped or rewritten on the way in.
    expect(config).toEqual(parse(raw));
  },
);

test("the multi example plans its short references, working_dir, named proxy and the working Target's build: false", async () => {
  const raw = await readFile(
    join(import.meta.dir, "../docs/examples/multi.rig.yaml"),
    "utf8",
  );
  const config = parseProjectConfig(parse(raw));
  const plan = (target: "working" | "stable") =>
    resolveTargetPlan({
      config,
      target,
      ...roots_,
      assignedPorts: { "web.http": 4100, "api.http": 4200, "db.pg": 5432 },
    });
  const stable = plan("stable");
  const web = stable.components.find((c) => c.name === "web")!;
  expect(web).toMatchObject({
    command: "bun dist/server.js",
    workingDir: "apps/web",
    health: "http://127.0.0.1:4100/health",
    env: { PORT: "4100" },
  });
  expect(stable.components.find((c) => c.name === "api")).toMatchObject({
    env: {
      PORT: "4200",
      DATABASE_URL: "postgres://postgres@127.0.0.1:5432/postgres",
    },
  });
  expect(stable.proxy).toEqual({
    upstream: "web",
    routes: [
      { prefix: "/api", service: "api", port: 4200 },
      { prefix: "/", service: "web", port: 4100 },
    ],
  });
  expect(stable.builds!.map((unit) => unit.id)).toContain("service:web");
  const working = plan("working");
  expect(working.builds!.map((unit) => unit.id)).not.toContain("service:web");
  expect(working.components.find((c) => c.name === "web")).toMatchObject({
    command: "bun run dev --port 4100",
    workingDir: "apps/web",
  });
});

test("a Project needs a Service or a Tool; a Tool-only Project needs no Service, domain or proxy", () => {
  for (const empty of [
    { name: "app" },
    { name: "app", services: {}, tools: {} },
  ])
    expect(failureOf(empty)).toMatchObject({
      code: "invalid_config",
      hint: expect.stringContaining(
        "services: A Project needs at least one Service or Tool.",
      ),
    });
  const config = parseProjectConfig({
    name: "report",
    tools: { report: { bin: ".rig-build/report", build: "make" } },
  });
  const plan = resolveTargetPlan({ config, target: "stable", ...roots_ });
  expect(plan.domain).toBeUndefined();
  expect(plan.proxy).toBeUndefined();
  expect(plan.components).toEqual([
    {
      name: "report",
      kind: "installed",
      env: {},
      envFiles: conventionFiles("stable", "report"),
      dependsOn: [],
      entrypoint: "/work/.rig-build/report",
    },
  ]);
  expect(plan.builds).toEqual([
    { id: "tool:report", component: "report", command: "make", timeout: 600 },
  ]);
});

test("a Tool may not share a Service's name", () => {
  expect(
    failureOf({ name: "app", services: web(), tools: { web: { bin: "x" } } }),
  ).toMatchObject({
    code: "invalid_config",
    hint: expect.stringContaining(
      "tools.web: A Tool cannot share its name with a Service.",
    ),
  });
});

test("Target names are fixed: the working and stable Targets plan under their role, and ${rig.target} names it", () => {
  const config = parseProjectConfig({
    name: "app",
    services: web({ environment: { TARGET: "${rig.target}" } }),
    targets: { working: true, stable: true },
  });
  for (const target of ["working", "stable"] as const) {
    const plan = resolveTargetPlan({ config, target, ...roots_ });
    expect(plan).toMatchObject({ target, deploymentName: target });
    expect(plan.components[0]!.env).toEqual({ TARGET: target });
  }
});

test.each(["working", "stable", "preview"])(
  "targets.%s.name is refused: Target names are fixed",
  (role) => {
    expect(
      failureOf({
        name: "app",
        services: web(),
        targets: { [role]: { name: "dev", environment: { A: "1" } } },
      }),
    ).toMatchObject({
      code: "invalid_config",
      hint: `Fix targets.${role}.name: Target names are fixed (working, stable, preview); delete this line.`,
    });
  },
);

test("the targets rig init used to write, names alone, are refused with how to keep each Target on", () => {
  expect(
    hintOf({
      name: "app",
      services: web(),
      targets: { working: { name: "local" }, stable: { name: "live" } },
    }),
  ).toBe(
    "Fix targets.working.name: Target names are fixed (working, stable, preview); delete this line, and write `working: true` to keep it on; targets.stable.name: Target names are fixed (working, stable, preview); delete this line, and write `stable: true` to keep it on.",
  );
});

test("a Target is on when its key is true or a settings map; false or a missing key is off, and without targets only working is on", () => {
  const on = (targets: unknown) => {
    const config = parseProjectConfig({
      name: "app",
      services: web(),
      ...(targets === undefined ? {} : { targets }),
    });
    return TARGET_ROLES.filter((role) => targetOn(config, role));
  };
  expect(on(undefined)).toEqual(["working"]);
  expect(on({})).toEqual([]);
  expect(on({ stable: true })).toEqual(["stable"]);
  expect(on({ working: true, stable: false, preview: {} })).toEqual([
    "working",
    "preview",
  ]);
  expect(
    on({ working: { environment: { A: "1" } }, stable: true, preview: true }),
  ).toEqual(["working", "stable", "preview"]);
});

test("a Target switch is true, false or a settings map, and a switch alone patches nothing", () => {
  expect(
    hintOf({ name: "app", services: web(), targets: { stable: "yes" } }),
  ).toBe("Fix targets.stable: must be true, false or a map of settings.");
  const config = parseProjectConfig({
    name: "app",
    services: web(),
    environment: { A: "base" },
    targets: { working: true, stable: { environment: { A: "stable" } } },
  });
  expect(patchedSettings(config, "working").environment).toEqual({ A: "base" });
  expect(patchedSettings(config, "stable").environment).toEqual({
    A: "stable",
  });
});

test("settings patches merge maps and replace lists and scalars, without leaking the Target switches or changing the base", () => {
  const config = parseProjectConfig({
    name: "app",
    environment: { A: "base", B: "base" },
    env_file: ["one.env", "two.env"],
    services: {
      web: {
        command: "serve",
        ports: { http: "auto", admin: "auto" },
        environment: { X: "base", Y: "base" },
        depends_on: ["db", "cache"],
      },
      db: { command: "db", ports: { pg: "auto" } },
      cache: { command: "cache" },
    },
    tools: { ctl: { bin: "bin/ctl", build: "make" } },
    targets: {
      working: {
        environment: { B: "patched", C: "patched" },
        env_file: ["dev.env"],
        services: {
          web: {
            command: "serve --watch",
            ports: { http: 8787 },
            environment: { Y: "patched" },
            depends_on: ["db"],
          },
        },
        tools: { ctl: { build: "make dev" } },
      },
    },
  });
  const base = structuredClone(config);
  const working = patchedSettings(config, "working");
  expect(working).toEqual({
    name: "app",
    environment: { A: "base", B: "patched", C: "patched" },
    env_file: ["dev.env"],
    services: {
      web: {
        command: "serve --watch",
        ports: { http: 8787, admin: "auto" },
        environment: { X: "base", Y: "patched" },
        depends_on: ["db"],
      },
      db: { command: "db", ports: { pg: "auto" } },
      cache: { command: "cache" },
    },
    tools: { ctl: { bin: "bin/ctl", build: "make dev" } },
  });
  expect(config).toEqual(base);
  // A role without a patch is the base settings, still without the Target switches.
  const { targets: _targets, ...settings } = base;
  expect(patchedSettings(config, "stable")).toEqual(settings);
  expect(patchedSettings(config, "preview")).toEqual(settings);
});

test("a Target patch cannot change identity, nest targets, name a Target, add or remove entries, or pin Preview ports", () => {
  const base = { name: "app", services: web(), tools: { ctl: { bin: "c" } } };
  expect(
    issuePaths({
      ...base,
      targets: {
        working: { production_branch: "dev", role: "stable" },
        stable: { description: "prod", targets: { working: {} } },
        preview: { name: "pr", services: { web: null }, tools: { ctl: null } },
      },
    }),
  ).toEqual([
    "targets.working.production_branch",
    "targets.working.role",
    "targets.stable.description",
    "targets.stable.targets",
    "targets.preview.name",
    "targets.preview.services.web",
    "targets.preview.tools.ctl",
  ]);
  expect(
    hintOf({ ...base, targets: { stable: { production_branch: "x" } } }),
  ).toBe(
    "Fix targets.stable.production_branch: The Production branch is Project-wide; set production_branch at the top level.",
  );
  expect(
    issuePaths({
      ...base,
      targets: {
        working: { services: { api: { command: "api" } } },
        stable: { tools: { other: { bin: "o" } } },
      },
    }),
  ).toEqual(["targets.working.services.api", "targets.stable.tools.other"]);
  expect(
    hintOf({
      ...base,
      targets: { preview: { services: { web: { ports: { http: 4000 } } } } },
    }),
  ).toContain(
    "targets.preview.services.web.ports.http: Previews always use chosen ports",
  );
  // The working and stable Targets may pin, and a Preview may say auto.
  expect(
    failureOf({
      ...base,
      targets: {
        working: { services: { web: { ports: { http: 8787 } } } },
        stable: { services: { web: { ports: { http: 8788 } } } },
        preview: { services: { web: { ports: { http: "auto" } } } },
      },
    }),
  ).toBeUndefined();
  expect(
    hintOf({ ...base, targets: { staging: { environment: { A: "b" } } } }),
  ).toBe('Fix targets: has no field named "staging".');
});

test("the patched model is validated, so a patch that breaks the graph is reported at the patch", () => {
  const services = {
    a: { command: "a", ports: { http: 3000 }, depends_on: ["b"] },
    b: { command: "b", ports: { http: "auto" } },
  };
  expect(
    hintOf({
      name: "app",
      services,
      targets: { stable: { services: { b: { depends_on: ["a"] } } } },
    }),
  ).toContain("targets.stable.services.");
  expect(
    hintOf({
      name: "app",
      services,
      targets: { working: { services: { b: { ports: { http: 3000 } } } } },
    }),
  ).toBe(
    "Fix targets.working.services.b.ports.http: Port 3000 is pinned by both a.http and b.http.",
  );
  expect(
    hintOf({
      name: "app",
      services,
      proxy: { "/": "${services.a.ports.http}" },
      targets: {
        preview: { proxy: { "/": "${services.b.ports.grpc}" } },
      },
    }),
  ).toContain(
    "targets.preview.proxy./: Proxy '/': 'b.grpc' is not a declared Service port",
  );
});

test("a proxy must include '/' and reference declared Service ports", () => {
  const services = {
    ...web(),
    api: { command: "api", ports: { http: "auto" } },
  };
  expect(
    parseProjectConfig({
      name: "app",
      services,
      proxy: {
        "/": "${services.web.ports.http}",
        "/api": "${services.api.ports.http}",
      },
    }).proxy,
  ).toEqual({
    "/": "${services.web.ports.http}",
    "/api": "${services.api.ports.http}",
  });
  const hint = (proxy: Record<string, string>) =>
    hintOf({ name: "app", services, proxy });
  expect(hint({ "/api": "${services.api.ports.http}" })).toBe(
    "Fix proxy: A proxy needs a '/' entry.",
  );
  expect(hint({ "/": "${services.web.ports.grpc}" })).toContain(
    "proxy./: Proxy '/': 'web.grpc' is not a declared Service port.",
  );
  expect(hint({ "/": "${services.missing.ports.http}" })).toContain(
    "proxy./: Proxy '/': 'missing' is not a declared Service",
  );
  expect(hint({ "/": "${services.constructor.ports.http}" })).toContain(
    "proxy./: Proxy '/': 'constructor' is not a declared Service",
  );
  expect(hint({ "/": "http://127.0.0.1:3000" })).toContain(
    "proxy./: must name a Service, such as web, or one of its ports, such as ${services.web.ports.http}",
  );
  // A Service name, or ${services.<name>.port}, means that Service's only port.
  expect(hint({ "/": "missing" })).toBe(
    "Fix proxy./: Proxy '/': 'missing' is not a declared Service.",
  );
  expect(
    hintOf({
      name: "app",
      services: {
        ...services,
        multi: { command: "m", ports: { http: "auto", admin: "auto" } },
        worker: { command: "w" },
      },
      proxy: { "/": "multi", "/w": "worker", "/m": "${services.multi.port}" },
    }),
  ).toBe(
    "Fix proxy./: Proxy '/': 'multi' has 2 ports (http, admin); name one, such as ${services.multi.ports.http}; proxy./w: Proxy '/w': 'worker' declares no port to route to; proxy./m: Proxy '/m': 'multi' has 2 ports (http, admin); name one, such as ${services.multi.ports.http}.",
  );
  expect(
    hint({
      "/": "${services.web.ports.http}",
      "/api/*": "${services.api.ports.http}",
    }),
  ).toContain("must be a path prefix starting with '/' without wildcards");
  expect(
    hint({
      "/": "${services.web.ports.http}",
      "/api": "${services.api.ports.http}",
      "/api/": "${services.web.ports.http}",
    }),
  ).toContain("proxy./api/: Proxy '/api/' and '/api' are the same path.");
  expect(
    hint({
      "/": "${services.web.ports.http}",
      "//": "${services.api.ports.http}",
    }),
  ).toContain("proxy.//: Proxy '//' names no path.");
});

// ---------------------------------------------------------------------------
// Schema: validation rules carried over
// ---------------------------------------------------------------------------

test("validation rejects missing dependencies, cycles and duplicate pinned ports at their field", () => {
  expect(
    hintOf({
      name: "app",
      services: {
        a: { command: "run", depends_on: ["b"] },
        b: { command: "run", depends_on: ["a"] },
      },
    }),
  ).toBe(
    "Fix services.a.depends_on: Service dependencies contain a cycle through 'a'.",
  );
  expect(
    hintOf({
      name: "app",
      services: { a: { command: "run", depends_on: ["missing"] } },
    }),
  ).toBe(
    "Fix services.a.depends_on: Dependency 'missing' of Service 'a' is not a declared Service.",
  );
  // A Tool is not something a Service can wait for.
  expect(
    hintOf({
      name: "app",
      services: { a: { command: "run", depends_on: ["ctl"] } },
      tools: { ctl: { bin: "bin/ctl" } },
    }),
  ).toContain("Dependency 'ctl' of Service 'a' is not a declared Service.");
  expect(
    hintOf({
      name: "app",
      services: {
        a: { command: "run", ports: { http: 3000 } },
        b: { command: "run", ports: { grpc: 3000 } },
      },
    }),
  ).toBe(
    "Fix services.b.ports.grpc: Port 3000 is pinned by both a.http and b.grpc.",
  );
});

test("dependency, patch and reference lookup never treats inherited object names as declared entries", () => {
  expect(
    hintOf({
      name: "app",
      services: { web: { command: "run", depends_on: ["constructor"] } },
    }),
  ).toContain("Dependency 'constructor' of Service 'web' is not a declared");
  expect(
    hintOf({
      name: "app",
      services: web(),
      targets: { working: { services: { constructor: { command: "x" } } } },
    }),
  ).toContain(
    "targets.working.services.constructor: A Target patch cannot add",
  );
  for (const name of ["__proto__", "toString"])
    expect(
      failureOf({
        name: "app",
        services: JSON.parse(`{"${name}":{"command":"serve"}}`),
      }),
    ).toMatchObject({ code: "invalid_config" });
  // `constructor` is a legal entry name and behaves like any other Service.
  const config = parseProjectConfig({
    name: "app",
    services: {
      constructor: { command: "serve", ports: { http: 3000 } },
      web: {
        command: "web --upstream ${services.constructor.ports.http}",
        ports: { http: 3001 },
        depends_on: ["constructor"],
      },
    },
  });
  const plan = resolveTargetPlan({ config, target: "working", ...roots_ });
  expect(plan.components.map((component) => component.name)).toEqual([
    "constructor",
    "web",
  ]);
  expect(plan.components[1]).toMatchObject({ command: "web --upstream 3000" });
});

test.each([
  "serve --host 0.0.0.0",
  "serve --bind=192.168.1.2",
  'serve --host "::"',
  "serve --addr 0.0.0.0:${services.server.ports.http}",
  "serve --addr=192.168.1.2:${services.server.ports.http}",
  'serve --addr "[::]:${services.server.ports.http}"',
  "serve --addr ${services.server.ports.http}:3210",
  'sh -c "node s.js --host 0.0.0.0"',
  "sh -c 'node s.js --host 0.0.0.0'",
  'sh -c "node s.js --host ::"',
  'bash -c "exec node s.js --bind 192.168.1.2 --port ${services.server.ports.http}"',
  "sh -c 'sh -c \"serve --listen 0.0.0.0\"'",
])("raw config rejects non-local binding %s", (run) => {
  expect(
    hintOf({
      name: "share",
      services: { server: { command: run, ports: { http: 3210 } } },
    }),
  ).toBe(
    "Fix services.server.command: Explicit network bindings must use 127.0.0.1 or localhost.",
  );
});

test.each([
  ["build", { build: "node proxy.js --host 0.0.0.0" }],
  [
    "services.web.build",
    { services: web({ build: 'sh -c "tunnel --listen 0.0.0.0:9000"' }) },
  ],
  ["tools.ctl.build", { tools: { ctl: { bin: "c", build: "x --bind ::" } } }],
  ["services.web.ready", { services: web({ ready: "probe --host 0.0.0.0" }) }],
  [
    "services.web.environment.HOST",
    { services: web({ environment: { HOST: "0.0.0.0" } }) },
  ],
  ["environment.LISTEN_ADDR", { environment: { LISTEN_ADDR: "::" } }],
  [
    "targets.preview.environment.BIND_ADDR",
    { targets: { preview: { environment: { BIND_ADDR: "[::]:3000" } } } },
  ],
  [
    "targets.stable.services.web.command",
    {
      targets: {
        stable: { services: { web: { command: "s --host 0.0.0.0" } } },
      },
    },
  ],
])(
  "builds, readiness commands, bind-style env values and patches are held to the localhost rule at %s",
  (path, extra) => {
    const hint = hintOf({ name: "app", services: web(), ...extra });
    expect(hint).toContain(`${path}: `);
    expect(hint).toMatch(/localhost/);
  },
);

test("env values that are not wildcard bindings are accepted, and a wrapped localhost command passes", () => {
  const config = parseProjectConfig({
    name: "app",
    services: web({
      command:
        'sh -c "node s.js --host 127.0.0.1 --port ${services.web.ports.http}"',
      ready: "curl -s http://localhost:${services.web.ports.http}/warm",
      environment: {
        HOST: "app.example.com",
        HOSTNAME: "mac.local",
        PUBLIC_URL: "http://0.0.0.0.nip.io",
      },
    }),
  });
  expect(config.services!.web).toMatchObject({
    environment: {
      HOST: "app.example.com",
      PUBLIC_URL: "http://0.0.0.0.nip.io",
    },
  });
});

test.each([
  "http://127.0.0.1'@evil.com/health",
  'http://127.0.0.1"@evil.com/health',
  "HTTP://10.0.0.1/health",
  "http://user:secret@127.0.0.1/health",
  "https://127.0.0.1.nip.io/health",
])(
  "readiness URLs are parsed whole and case-insensitively, so %s is rejected",
  (ready) => {
    expect(hintOf({ name: "app", services: web({ ready }) })).toBe(
      "Fix services.web.ready: Health checks must address 127.0.0.1 or localhost.",
    );
  },
);

test.each([
  "http://127.0.0.1:4000/?next=http://example.com",
  "HTTP://LOCALHOST:${services.web.ports.http}/health",
  "curl -fsS http://example.com/ping",
])("readiness value %s is accepted", (ready) => {
  const config = parseProjectConfig({ name: "app", services: web({ ready }) });
  expect(config.services!.web).toMatchObject({ ready });
});

test("the removed supervisor setting is refused with guidance to delete it, at every level that took one, and rigd supervises every plan", () => {
  for (const [path, extra] of [
    ["supervisor", { supervisor: "launchd" }],
    ["supervisor", { supervisor: "rigd" }],
    [
      "targets.stable.supervisor",
      { targets: { stable: { supervisor: "launchd" } } },
    ],
  ] as const)
    expect(failureOf({ name: "app", services: web(), ...extra })).toMatchObject(
      {
        code: "invalid_config",
        hint: `Fix ${path}: was removed because rigd supervises every Service; delete this line.`,
      },
    );
  const config = parseProjectConfig({ name: "app", services: web() });
  const supervisorOf = (target: "working" | "stable") =>
    resolveTargetPlan({ config, target, ...roots_ }).providers
      .processSupervisor;
  expect([supervisorOf("working"), supervisorOf("stable")]).toEqual([
    "rigd",
    "rigd",
  ]);
});

test("a format line is refused with guidance to delete it, whatever format it names", () => {
  for (const format of ["rig/v1", "rig/v2", "rig/v3"])
    expect(failureOf({ format, name: "app", services: web() })).toMatchObject({
      code: "invalid_config",
      hint: "Fix format: was removed because Rig reads one rig.yaml format; delete this line.",
    });
});

test("run and env are refused wherever they are spelled, each naming its Compose name", () => {
  const { command, ...noCommand } = web().web;
  for (const [path, input] of [
    ["services.web.run", { services: { web: { ...noCommand, run: command } } }],
    ["services.web.env", { services: web({ env: { A: "1" } }) }],
    ["env", { env: { A: "1" }, services: web() }],
    [
      "targets.working.env",
      { services: web(), targets: { working: { env: { A: "1" } } } },
    ],
    [
      "targets.preview.services.web.run",
      {
        services: web(),
        targets: { preview: { services: { web: { run: "serve" } } } },
      },
    ],
    [
      "targets.stable.services.web.env",
      {
        services: web(),
        targets: { stable: { services: { web: { env: { A: "1" } } } } },
      },
    ],
  ] as const) {
    const [from, to] = path.endsWith("run")
      ? ["run", "command"]
      : ["env", "environment"];
    const message = `\`${from}\` is now \`${to}\`; rename this key`;
    expect(failureOf({ name: "app", ...input })).toMatchObject({
      code: "invalid_config",
      hint: `Fix ${path}: ${message}.`,
      context: { issues: [{ path: path.split("."), message }] },
    });
  }
});

test("working_dir is a directory inside the workspace, recorded normalized and patchable per Target; env_file paths stay workspace-relative", () => {
  const message =
    "must be a directory inside the workspace, relative to it, such as apps/web: no absolute path, ~, '..' or reference";
  for (const value of [
    "/srv/app",
    "~/app",
    "..",
    "../sibling",
    "apps/../../x",
    "${rig.workspace}/apps",
    "",
  ])
    expect(
      failureOf({ name: "app", services: web({ working_dir: value }) })?.context
        .issues,
    ).toEqual([
      {
        path: ["services", "web", "working_dir"],
        message: value === "" ? "must not be empty" : message,
      },
    ]);
  expect(
    issuePaths({
      name: "app",
      services: web(),
      targets: { stable: { services: { web: { working_dir: "../x" } } } },
    }),
  ).toEqual(["targets.stable.services.web.working_dir"]);
  const config = parseProjectConfig({
    name: "app",
    services: web({ working_dir: "./apps/web/", env_file: "apps/web/.env" }),
    targets: {
      working: true,
      stable: { services: { web: { working_dir: "dist/web" } } },
      preview: { services: { web: { working_dir: "." } } },
    },
  });
  const planned = (target: "working" | "stable" | "preview") =>
    resolveTargetPlan({ config, target, ...roots_, assignedPorts: { web: 1 } })
      .components[0]!;
  expect(planned("working")).toMatchObject({ workingDir: "apps/web" });
  expect(planned("stable")).toMatchObject({ workingDir: "dist/web" });
  // The workspace root is the default, so a plan that runs there records nothing, as before working_dir existed.
  expect(planned("preview")).not.toHaveProperty("workingDir");
  expect(planned("working").envFiles!.find((file) => file.required)).toEqual({
    path: "/work/apps/web/.env",
    required: true,
  });
});

test("${port} and ${ports.<port>} name the ports of the Service whose setting holds them, and ${services.<service>.port} a Service's only port anywhere", () => {
  const config = parseProjectConfig({
    name: "app",
    build: "make PORT=${services.web.port}",
    environment: { WEB: "http://127.0.0.1:${services.web.port}" },
    services: {
      web: {
        command: "serve --port ${port}",
        build: "make web-${port}",
        ports: { http: "auto" },
        ready: "http://127.0.0.1:${port}/health",
        environment: {
          PORT: "${port}",
          SELF: "http://127.0.0.1:${port}",
          API: "http://127.0.0.1:${services.api.ports.http}",
        },
        env_file: "env/${port}.env",
      },
      api: {
        command: "api --http ${ports.http} --admin ${ports.admin}",
        ports: { http: "auto", admin: "auto" },
        // A value read through another Service's setting keeps that setting's own Service.
        environment: { WEB: "${services.web.environment.SELF}" },
      },
    },
    tools: { ctl: { bin: "ctl", build: "make ctl-${services.web.port}" } },
  });
  const plan = resolveTargetPlan({
    config,
    target: "working",
    ...roots_,
    assignedPorts: { "web.http": 4100, "api.http": 4200, "api.admin": 4201 },
  });
  const component = (name: string) =>
    plan.components.find((entry) => entry.name === name)!;
  expect(component("web")).toMatchObject({
    command: "serve --port 4100",
    health: "http://127.0.0.1:4100/health",
    env: {
      WEB: "http://127.0.0.1:4100",
      PORT: "4100",
      API: "http://127.0.0.1:4200",
    },
  });
  expect(component("web").envFiles!.find((file) => file.required)!.path).toBe(
    "/work/env/4100.env",
  );
  expect(component("api")).toMatchObject({
    command: "api --http 4200 --admin 4201",
    env: { WEB: "http://127.0.0.1:4100" },
  });
  expect(plan.builds!.map((unit) => unit.command)).toEqual([
    "make PORT=4100",
    "make web-4100",
    "make ctl-4100",
  ]);
  // The long form still works beside them.
  expect(
    failureOf({
      name: "app",
      services: web({ command: "serve --port ${services.web.ports.http}" }),
    }),
  ).toBeUndefined();
});

test("a short port reference that has no Service, or no single port, is refused with what to write instead", () => {
  const two = { http: "auto", admin: "auto" };
  for (const [input, path, message] of [
    [
      { build: "make ${port}", services: web() },
      "build",
      "${port} in build has no Service; write ${services.<service>.port} or ${services.<service>.ports.<port>}.",
    ],
    [
      { environment: { P: "${ports.http}" }, services: web() },
      "environment.P",
      "${ports.http} in environment.P has no Service; write ${services.<service>.port} or ${services.<service>.ports.<port>}.",
    ],
    [
      {
        services: web(),
        tools: { ctl: { bin: "ctl", build: "make ${port}" } },
      },
      "tools.ctl.build",
      "${port} in tools.ctl.build has no Service; write ${services.<service>.port} or ${services.<service>.ports.<port>}.",
    ],
    [
      { services: { web: { command: "serve ${port}" } } },
      "services.web.command",
      "${port} in services.web.command needs one port, but 'web' has none; declare one, such as ports: { http: auto }.",
    ],
    [
      { services: web({ command: "serve ${port}", ports: two }) },
      "services.web.command",
      "${port} in services.web.command needs one port, but 'web' has 2 (http, admin); name one, such as ${ports.http}.",
    ],
    [
      {
        environment: { URL: "${services.web.port}" },
        services: web({ ports: two }),
      },
      "environment.URL",
      "${services.web.port} in environment.URL needs one port, but 'web' has 2 (http, admin); name one, such as ${services.web.ports.http}.",
    ],
    [
      { services: web({ command: "serve ${ports.grpc}" }) },
      "services.web.command",
      "Unknown reference '${ports.grpc}' in services.web.command: Service 'web' declares the ports http.",
    ],
    [
      { environment: { URL: "${services.api.port}" }, services: web() },
      "environment.URL",
      "Unknown reference '${services.api.port}' in environment.URL: 'api' is not a declared Service.",
    ],
  ] as const)
    expect(failureOf({ name: "app", ...input })?.context.issues).toEqual([
      { path: path.split("."), message },
    ]);
  // At plan time the reference carries a hint naming the fix.
  expect(() =>
    referenceResolver(
      { services: { web: { ports: two } } },
      {
        target: "t",
        workspace: "/w",
        host: "",
        url: "",
        data: () => "/d",
        port: () => 1,
      },
    ).text("${port}", "services.web.command"),
  ).toThrow(
    expect.objectContaining({
      code: "ambiguous_port",
      hint: "Write ${ports.<port>} with one of http, admin.",
    }),
  );
});

test("build: false in a Target patch turns an inherited Project or Service build off for that role only; at the top level it is refused", () => {
  const config = parseProjectConfig({
    name: "app",
    build: "make all",
    services: web({ build: "make web" }),
    tools: { ctl: { bin: "ctl", build: "make ctl" } },
    targets: {
      working: { build: false, services: { web: { build: false } } },
      stable: true,
      preview: { services: { web: { build: false } } },
    },
  });
  const builds = (target: "working" | "stable" | "preview") =>
    resolveTargetPlan({
      config,
      target,
      ...roots_,
      assignedPorts: { web: 1 },
    }).builds?.map((unit) => unit.id);
  expect(builds("working")).toEqual(["tool:ctl"]);
  expect(builds("stable")).toEqual(["shared", "service:web", "tool:ctl"]);
  expect(builds("preview")).toEqual(["shared", "tool:ctl"]);
  expect(patchedSettings(config, "working")).not.toHaveProperty("build");
  expect(patchedSettings(config, "working").services!.web).not.toHaveProperty(
    "build",
  );
  // The patch keeps what the author wrote; only the role's settings lose the build.
  expect(config.targets!.working).toMatchObject({ build: false });
  const message =
    "build: false only turns an inherited build off in a Target patch; delete this line for no build";
  for (const [path, input] of [
    ["build", { build: false, services: web() }],
    ["services.web.build", { services: web({ build: false }) }],
  ] as const)
    expect(failureOf({ name: "app", ...input })?.context.issues).toEqual([
      { path: path.split("."), message },
    ]);
  // true is not a build command.
  expect(
    hintOf({
      name: "app",
      services: web(),
      targets: { stable: { build: true } },
    }),
  ).toBe(
    "Fix targets.stable.build: must be a command, or false to turn the inherited build off.",
  );
  expect(
    hintOf({
      name: "app",
      services: web(),
      targets: { stable: { services: { web: { build: 7 } } } },
    }),
  ).toBe(
    "Fix targets.stable.services.web.build: must be a command, or false to turn the inherited build off.",
  );
  // A Tool's bin comes from its build, so no role may turn it off, and neither may its own declaration.
  const toolOff =
    "build: false is not allowed for a Tool, whose build makes its bin; give another command or leave the key out";
  for (const [path, input] of [
    [
      "targets.stable.tools.ctl.build",
      {
        tools: { ctl: { bin: "ctl", build: "make" } },
        targets: { stable: { tools: { ctl: { build: false } } } },
      },
    ],
    ["tools.ctl.build", { tools: { ctl: { bin: "ctl", build: false } } }],
  ] as const)
    expect(failureOf({ name: "app", ...input })?.context.issues).toEqual([
      { path: path.split("."), message: toolOff },
    ]);
});

test("a reference through env names the environment path that replaced it", () => {
  for (const [reference, replacement] of [
    ["${env.MODE}", "${environment.MODE}"],
    ["${services.web.env.LABEL}", "${services.web.environment.LABEL}"],
  ])
    expect(
      failureOf({
        name: "app",
        environment: { MODE: "dev" },
        services: web({
          environment: { LABEL: "x", COPY: reference },
        }),
      }),
    ).toMatchObject({
      code: "invalid_config",
      hint: `Fix services.web.environment.COPY: Reference '${reference}' in services.web.environment.COPY names \`env\`, which is now \`environment\`: write ${replacement}.`,
    });
  // At plan time the same reference carries its own hint, naming the new path.
  expect(() =>
    referenceResolver(
      { environment: { MODE: "dev" } },
      {
        target: "t",
        workspace: "/w",
        host: "",
        url: "",
        data: () => "/d",
        port: () => 1,
      },
    ).text("${env.MODE}", "build"),
  ).toThrow(
    expect.objectContaining({
      code: "renamed_reference",
      hint: "Write ${environment.MODE} instead.",
    }),
  );
});

test("a health block is refused wherever a Service is spelled, naming ready and ready_timeout as its replacement", () => {
  const removed =
    "was removed with ongoing health checks; write its check as ready and its start_timeout as ready_timeout";
  for (const [path, extra] of [
    [
      "services.web.health",
      { services: web({ health: { check: "true", start_timeout: "1m" } }) },
    ],
    [
      "targets.preview.services.web.health",
      {
        services: web(),
        targets: { preview: { services: { web: { health: {} } } } },
      },
    ],
  ] as const)
    expect(failureOf({ name: "app", ...extra })).toMatchObject({
      code: "invalid_config",
      hint: `Fix ${path}: ${removed}.`,
      context: { issues: [{ path: path.split("."), message: removed }] },
    });
  // The same settings as ready and ready_timeout plan the start check they named.
  const config = parseProjectConfig({
    name: "app",
    services: web({ ready: "true", ready_timeout: "1m" }),
  });
  expect(
    resolveTargetPlan({ config, target: "working", ...roots_ }).components,
  ).toMatchObject([{ name: "web", health: "true", readyTimeout: 60 }]);
  // A reference to ready_timeout reads the selected Target's value, its role's patch included.
  const referenced = parseProjectConfig({
    name: "app",
    services: web({
      ready_timeout: "1m",
      environment: { READY_TIMEOUT: "${services.web.ready_timeout}" },
    }),
    targets: { stable: { services: { web: { ready_timeout: "5m" } } } },
  });
  const readyEnv = (target: "working" | "stable") =>
    resolveTargetPlan({ config: referenced, target, ...roots_ }).components[0]!
      .env;
  expect(readyEnv("working")).toMatchObject({ READY_TIMEOUT: "1m" });
  expect(readyEnv("stable")).toMatchObject({ READY_TIMEOUT: "5m" });
});

test("durations are written like 30s, 10m or 1h, bounded to one day, and reach the plan in seconds", () => {
  expect(
    failureOf({
      name: "app",
      build_timeout: "2d",
      services: web({ ready_timeout: "86401s", build_timeout: "25h" }),
      tools: { ctl: { bin: "c", build_timeout: "0s" } },
    }),
  ).toMatchObject({
    code: "invalid_config",
    context: {
      issues: [
        "build_timeout",
        "services.web.build_timeout",
        "services.web.ready_timeout",
        "tools.ctl.build_timeout",
      ].map((path) => ({
        path: path.split("."),
        message:
          "must be a positive duration of at most one day, such as 30s, 10m or 1h",
      })),
    },
  });
  for (const ready_timeout of ["30", "1.5m", "-5s", "10 m", "1d", "01s"])
    expect(hintOf({ name: "app", services: web({ ready_timeout }) })).toContain(
      "services.web.ready_timeout: must be a positive duration",
    );
  expect(hintOf({ name: "app", services: web({ ready_timeout: 30 }) })).toBe(
    "Fix services.web.ready_timeout: must be a string.",
  );
  const config = parseProjectConfig({
    name: "app",
    build_timeout: "24h",
    services: {
      ...web({ ready_timeout: "86400s" }),
      api: { command: "api", ports: { http: 3001 } },
    },
    tools: {
      ctl: { bin: "c", build: "make", build_timeout: "20m" },
      other: { bin: "o", build: "make" },
    },
    targets: { stable: { tools: { ctl: { build_timeout: "30m" } } } },
  });
  const budgets = (target: "working" | "stable") => {
    const plan = resolveTargetPlan({ config, target, ...roots_ });
    return Object.fromEntries(
      plan.components.map((component) => [
        component.name,
        component.kind === "managed"
          ? component.readyTimeout
          : plan.builds?.find((unit) => unit.component === component.name)
              ?.timeout,
      ]),
    );
  };
  // A Service defaults to 30s; a Tool falls back to the Project build budget; a patch overrides both.
  expect(budgets("working")).toEqual({
    web: 86400,
    api: 30,
    ctl: 1200,
    other: 86400,
  });
  expect(budgets("stable")).toMatchObject({ ctl: 1800 });
});

test("stop_timeout is a duration from 1s to 1h, defaults to 10s, is patchable per role and reaches the plan in seconds", () => {
  for (const stop_timeout of ["0s", "3601s", "2h", "1.5m", "10"])
    expect(hintOf({ name: "app", services: web({ stop_timeout }) })).toBe(
      "Fix services.web.stop_timeout: must be a duration from 1s to 1h, such as 10s, 2m or 1h.",
    );
  expect(
    hintOf({
      name: "app",
      services: web(),
      targets: { preview: { services: { web: { stop_timeout: "90m" } } } },
    }),
  ).toContain("targets.preview.services.web.stop_timeout");
  const config = parseProjectConfig({
    name: "app",
    services: {
      ...web({ stop_timeout: "2m" }),
      api: { command: "api", ports: { http: 3001 } },
      worker: { command: "work", stop_timeout: "1h" },
    },
    targets: { stable: { services: { web: { stop_timeout: "25m" } } } },
  });
  const graces = (target: "working" | "stable") =>
    Object.fromEntries(
      resolveTargetPlan({ config, target, ...roots_ }).components.map(
        (component) => [
          component.name,
          component.kind === "managed" ? component.stopTimeout : undefined,
        ],
      ),
    );
  expect(graces("working")).toEqual({ web: 120, api: 10, worker: 3600 });
  expect(graces("stable")).toEqual({ web: 1500, api: 10, worker: 3600 });
});

test("validation hints describe the rule in plain words, never Zod's pattern or key text", () => {
  expect(hintOf({ name: "-bad", services: web() })).toBe(
    "Fix name: must start with a letter or digit and contain only letters, digits, '_' or '-'.",
  );
  expect(hintOf({ name: "app", services: web(), bogusField: 1 })).toBe(
    'Fix config: has no field named "bogusField".',
  );
  expect(hintOf({ name: "app", services: web({ port: 3000 }) })).toBe(
    'Fix services.web: has no field named "port".',
  );
  expect(hintOf({ name: "app", services: { web: { ports: {} } } })).toBe(
    "Fix services.web.command: must be a string.",
  );
  expect(
    hintOf({ name: "app", services: web({ ports: { http: "4000" } }) }),
  ).toBe("Fix services.web.ports.http: must be a number.");
  expect(hintOf({ name: "app", services: web({ ports: { http: 0 } }) })).toBe(
    "Fix services.web.ports.http: must be at least 1.",
  );
  expect(
    hintOf({ name: "app", services: web({ ports: { http: 65536 } }) }),
  ).toBe("Fix services.web.ports.http: must be at most 65535.");
  expect(
    hintOf({ name: "app", services: web({ environment: { PORT: 3000 } }) }),
  ).toBe("Fix services.web.environment.PORT: must be a string.");
  expect(
    hintOf({ name: "app", services: web({ environment: { "1BAD": "x" } }) }),
  ).toBe(
    "Fix services.web.environment.1BAD: must be an environment variable name: letters, digits and '_', not starting with a digit.",
  );
  expect(hintOf({ name: "app", services: web({ restart: "never" }) })).toBe(
    'Fix services.web.restart: must be one of "always", "on-failure", "no".',
  );
  expect(hintOf({ name: "app", services: web({ env_file: [] }) })).toBe(
    "Fix services.web.env_file: must list at least 1 entries.",
  );
  expect(
    hintOf({ name: "app", services: { "Bad Name": { command: "serve" } } }),
  ).toBe(
    "Fix services.Bad Name: must start with a lowercase letter or digit and contain only lowercase letters, digits or '-'.",
  );
  for (const hint of [
    hintOf({ name: "-bad", services: { "Bad Name": { command: "" } } }),
    hintOf({ name: "app", services: web({ ports: { Http: 1 } }) }),
  ]) {
    expect(hint).not.toBe("");
    expect(hint).not.toMatch(/Invalid|regex|pattern|\^\[|Unrecognized/i);
  }
});

test("invalid config errors carry bounded safe field guidance and the source path, never input values", async () => {
  const root = await fixture(),
    path = join(root, "rig.yaml");
  await writeFile(
    path,
    [
      "name: app",
      "services:",
      "  web:",
      "    command: serve --token do-not-expose-this-value --host 0.0.0.0",
      "    ports: {http: 0}",
      "    environment: {SECRET: do-not-expose-this-value, HOST: 0.0.0.0}",
      ...Array.from({ length: 40 }, (_, index) => `unknown_field_${index}: 1`),
    ].join("\n"),
  );
  const failure = (await readProjectConfig(root).catch(
    (error: unknown) => error,
  )) as { code: string; message: string; hint: string; context: unknown };
  expect(failure.code).toBe("invalid_config");
  expect(failure.hint).toContain("services.web.ports.http");
  expect(failure.hint).toContain(path);
  expect(failure.hint.length).toBeLessThan(1200);
  expect(
    failure.message + failure.hint + JSON.stringify(failure.context),
  ).not.toContain("do-not-expose-this-value");
});

test("a domain must be a hostname: schemes, ports, paths, wildcards, lists and other references are refused at parse or after substitution", () => {
  for (const domain of [
    "*",
    ":80",
    "*.app.test",
    "app.test/admin",
    "app.test,other.test",
    "http://0.0.0.0",
    "app.test:8080",
    ".app.test",
    "${rig.workspace}.app.test",
    "${services.web.ports.http}.app.test",
  ]) {
    expect(failureOf({ name: "app", services: web(), domain })).toMatchObject({
      code: "invalid_config",
      hint: expect.stringContaining("domain: must be a hostname"),
    });
    expect(
      hintOf({
        name: "app",
        services: web(),
        targets: { preview: { domain } },
      }),
    ).toContain("targets.preview.domain: must be a hostname");
  }
  const config = parseProjectConfig({
    name: "app",
    services: web(),
    domain: "app.test",
    proxy: { "/": "${services.web.ports.http}" },
    targets: {
      working: { domain: "${rig.target}.app.test" },
      preview: { domain: "${rig.target}.preview.app.test" },
    },
  });
  const plan = (
    target: "working" | "stable" | "preview",
    deploymentName?: string,
  ) =>
    resolveTargetPlan({
      config,
      target,
      ...roots_,
      assignedPorts: { web: 4100 },
      ...(deploymentName ? { deploymentName } : {}),
    });
  expect(plan("working").domain).toBe("working.app.test");
  expect(plan("stable").domain).toBe("app.test");
  expect(plan("preview", "feature-0a1b2c3d").domain).toBe(
    "feature-0a1b2c3d.preview.app.test",
  );
  expect(() => plan("preview", "*")).toThrow(
    expect.objectContaining({
      _tag: "ConfigError",
      code: "invalid_domain",
      message: "Domain '*.preview.app.test' is not a hostname.",
      context: { domain: "*.preview.app.test", path: "domain" },
    }),
  );
});

// ---------------------------------------------------------------------------
// Target plan resolution (the narrow bridge)
// ---------------------------------------------------------------------------

test("Target resolution provides forward port references, environment inheritance, per-Service data and dependency order", () => {
  const config = parseProjectConfig({
    name: "pantry",
    environment: { MODE: "base", LOG: "json" },
    services: {
      web: {
        command:
          "serve --host 127.0.0.1 --port ${services.web.ports.http} --data ${rig.data}",
        ports: { http: "auto" },
        depends_on: ["db", "api"],
        environment: {
          API: "http://127.0.0.1:${services.api.ports.http}",
          LOG: "service",
          SELF: "${rig.url}",
          HOSTED: "${rig.host}",
        },
      },
      api: {
        command: "api --port ${services.api.ports.http}",
        ports: { http: "auto" },
        environment: { DATA_DIR: "${rig.data}", ROOT: "${rig.workspace}" },
      },
      db: { command: "db", ports: { pg: "auto" } },
    },
    tools: { ctl: { bin: "bin/ctl" } },
    proxy: { "/": "${services.web.ports.http}" },
    targets: {
      working: {
        environment: { MODE: "dev" },
        services: {
          web: { ports: { http: 5173 }, environment: { LOG: "patched" } },
          api: { ports: { http: 8081 } },
        },
      },
    },
  });
  const plan = resolveTargetPlan({
    config,
    target: "working",
    workspacePath: "/repo",
    dataRoot: "/state/data",
    assignedPorts: { db: 5433, web: 1, api: 2 },
  });
  expect(plan).toMatchObject({
    project: "pantry",
    target: "working",
    deploymentName: "working",
    workspacePath: "/repo",
    dataRoot: "/state/data",
    providers: { processSupervisor: "rigd" },
  });
  expect(plan.components.map((component) => component.name)).toEqual([
    "db",
    "api",
    "web",
    "ctl",
  ]);
  expect(plan.components[0]).toMatchObject({ kind: "managed", port: 5433 });
  expect(plan.components[1]).toEqual({
    name: "api",
    kind: "managed",
    command: "api --port 8081",
    port: 8081,
    ports: { http: 8081 },
    readyTimeout: 30,
    // No stop_timeout: the 10 s default is recorded in the plan.
    stopTimeout: 10,
    restart: "always",
    dependsOn: [],
    env: {
      MODE: "dev",
      LOG: "json",
      DATA_DIR: "/state/data/api",
      ROOT: "/repo",
    },
    envFiles: [
      ...conventionFiles("working", "pantry"),
      ...conventionFiles("working", "pantry", "api"),
    ],
  });
  expect(plan.components[2]).toMatchObject({
    command: "serve --host 127.0.0.1 --port 5173 --data /state/data/web",
    port: 5173,
    dependsOn: ["db", "api"],
    env: {
      MODE: "dev",
      LOG: "patched",
      API: "http://127.0.0.1:8081",
      // No hostname for the Working copy: the URL is the local root port and the host is empty.
      SELF: "http://127.0.0.1:5173",
      HOSTED: "",
    },
  });
  // A Tool receives the Project's public env only, never a Service's.
  expect(plan.components[3]).toEqual({
    name: "ctl",
    kind: "installed",
    entrypoint: "/repo/bin/ctl",
    dependsOn: [],
    env: { MODE: "dev", LOG: "json" },
    envFiles: conventionFiles("working", "pantry"),
  });
});

test("proxy may name a Service for its only port, and a Target with a hostname and no proxy routes '/' to the one Service with one port", () => {
  const services = {
    web: { command: "web", ports: { http: "auto" } },
    api: { command: "api", ports: { http: "auto", admin: "auto" } },
    worker: { command: "worker" },
  };
  const routesOf = (config: Record<string, unknown>, target = "stable") =>
    resolveTargetPlan({
      config: parseProjectConfig({ name: "app", ...config }),
      target: target as "working" | "stable" | "preview",
      ...roots_,
      assignedPorts: { "web.http": 4100, "api.http": 4200, "api.admin": 4201 },
    }).proxy;
  const long = routesOf({
    domain: "app.test",
    services,
    proxy: {
      "/": "${services.web.ports.http}",
      "/api": "${services.api.ports.admin}",
    },
    targets: { stable: true },
  });
  expect(long).toEqual({
    upstream: "web",
    routes: [
      { prefix: "/api", service: "api", port: 4201 },
      { prefix: "/", service: "web", port: 4100 },
    ],
  });
  expect(
    routesOf({
      domain: "app.test",
      services,
      proxy: { "/": "web", "/api": "${services.api.ports.admin}" },
      targets: { stable: true },
    }),
  ).toEqual(long);
  expect(
    routesOf({
      domain: "app.test",
      services,
      proxy: {
        "/": "${services.web.port}",
        "/api": "${services.api.ports.admin}",
      },
      targets: { stable: true },
    }),
  ).toEqual(long);
  // The default: the one Service that declares ports, when it declares one.
  const single = { web: services.web, worker: services.worker };
  expect(
    routesOf({
      domain: "app.test",
      services: single,
      targets: { stable: true },
    }),
  ).toEqual({
    upstream: "web",
    routes: [{ prefix: "/", service: "web", port: 4100 }],
  });
  // A Target with no hostname gets no default route.
  expect(
    routesOf({ domain: "app.test", services: single }, "working"),
  ).toBeUndefined();
  // A patch may name the Service too.
  expect(
    routesOf(
      {
        services: single,
        targets: { working: { domain: "dev.test", proxy: { "/": "web" } } },
      },
      "working",
    ),
  ).toEqual({
    upstream: "web",
    routes: [{ prefix: "/", service: "web", port: 4100 }],
  });
});

test("a Target that is on and has a hostname but no usable proxy is refused with what to add", () => {
  const issues = (config: Record<string, unknown>) =>
    failureOf({ name: "app", ...config })?.context.issues;
  const two = {
    web: { command: "web", ports: { http: "auto" } },
    api: { command: "api", ports: { http: "auto" } },
  };
  expect(
    issues({ domain: "app.test", services: two, targets: { stable: true } }),
  ).toEqual([
    {
      path: ["domain"],
      message:
        "The stable Target serves domain but several Services have ports; add proxy: { /: web } at the top level or under targets.stable.",
    },
  ]);
  expect(
    issues({
      domain: "app.test",
      services: {
        web: { command: "web", ports: { http: "auto", admin: 3000 } },
      },
      targets: { preview: true },
    }),
  ).toEqual([
    {
      path: ["domain"],
      message:
        "Previews get a hostname from domain but 'web' has several ports; add proxy: { /: ${services.web.ports.http} } at the top level or under targets.preview.",
    },
  ]);
  expect(
    issues({
      services: { worker: { command: "worker" } },
      targets: { working: { domain: "dev.test" } },
    }),
  ).toEqual([
    {
      path: ["targets", "working", "domain"],
      message:
        "The working Target has a hostname but no Service has a port; declare one, such as ports: { http: auto }, or remove the domain.",
    },
  ]);
  // A Target that is off, or has no hostname, needs no proxy: without targets only working is on, and it has no hostname.
  expect(issues({ domain: "app.test", services: two })).toBeUndefined();
  expect(
    issues({ domain: "app.test", services: two, targets: { working: true } }),
  ).toBeUndefined();
  // A proxy in the role's patch is enough for that role, and the refusal names the role that still has none.
  expect(
    issues({
      domain: "app.test",
      services: two,
      targets: { stable: { proxy: { "/": "api" } } },
    }),
  ).toBeUndefined();
  expect(
    issues({
      domain: "app.test",
      services: two,
      targets: { stable: { proxy: { "/": "web" } }, preview: true },
    }),
  ).toEqual([
    {
      path: ["domain"],
      message:
        "Previews get a hostname from domain but several Services have ports; add proxy: { /: web } at the top level or under targets.preview.",
    },
  ]);
  expect(
    issues({
      services: two,
      targets: { preview: { domain: "${rig.target}.app.test" } },
    }),
  ).toEqual([
    {
      path: ["targets", "preview", "domain"],
      message:
        "Previews have a hostname but several Services have ports; add proxy: { /: web } at the top level or under targets.preview.",
    },
  ]);
});

test("rig.host names the routed hostname, and rig.url the route or the local address of the Service behind '/'", () => {
  const services = web({
    environment: { HOSTED: "${rig.host}", URL: "${rig.url}" },
  });
  const envOf = (config: unknown) =>
    resolveTargetPlan({
      config: parseProjectConfig(config),
      target: "stable",
      ...roots_,
    }).components[0]!.env;
  expect(
    envOf({
      name: "app",
      domain: "app.test",
      services,
      proxy: { "/": "${services.web.ports.http}" },
    }),
  ).toEqual({ HOSTED: "app.test", URL: "https://app.test" });
  // Without a proxy, '/' is the one Service with one port: the hostname routes to it, and without a hostname rig.url is
  // its local address, as with an explicit proxy.
  expect(envOf({ name: "app", domain: "app.test", services })).toEqual({
    HOSTED: "app.test",
    URL: "https://app.test",
  });
  expect(
    envOf({
      name: "app",
      services,
      proxy: { "/": "${services.web.ports.http}" },
    }),
  ).toEqual({ HOSTED: "", URL: "http://127.0.0.1:3000" });
  expect(envOf({ name: "app", services })).toEqual({
    HOSTED: "",
    URL: "http://127.0.0.1:3000",
  });
  // With no single Service to default to, a Target with neither proxy nor hostname has no URL.
  const two = {
    ...services,
    api: {
      command: "api",
      ports: { http: 3001 },
      environment: { URL: "${rig.url}" },
    },
  };
  expect(envOf({ name: "app", services: two })).toEqual({
    HOSTED: "",
    URL: "",
  });
  expect(
    resolveTargetPlan({
      config: parseProjectConfig({ name: "app", services }),
      target: "stable",
      ...roots_,
    }).proxy,
  ).toBeUndefined();
});

test("Preview plans use assigned ports and ignore pins, keep Branch identity, and refuse missing or colliding ports", () => {
  const config = parseProjectConfig({
    name: "app",
    domain: "example.com",
    services: {
      web: {
        command: "serve --port ${services.web.ports.http}",
        ports: { http: 3000 },
        ready: "http://127.0.0.1:${services.web.ports.http}/health",
        depends_on: ["db"],
      },
      db: {
        command: "db -p ${services.db.ports.pg}",
        ports: { pg: 5432 },
        ready: "pg_isready -h 127.0.0.1 -p ${services.db.ports.pg}",
      },
    },
    tools: { tool: { bin: "bin/tool", build: "bun build" } },
    proxy: { "/": "${services.web.ports.http}" },
  });
  const preview = (assignedPorts?: Record<string, number>) =>
    resolveTargetPlan({
      config,
      target: "preview",
      branch: "feature/test",
      commit: "abc",
      deploymentName: "feature-test-0a1b2c3d",
      ...roots_,
      ...(assignedPorts ? { assignedPorts } : {}),
    });
  const plan = preview({ web: 4000, db: 5433 });
  expect(plan).toMatchObject({
    target: "preview",
    deploymentName: "feature-test-0a1b2c3d",
    domain: "example-feature-test-0a1b2c3d.com",
    branch: "feature/test",
    commit: "abc",
    providers: { processSupervisor: "rigd" },
    proxy: { upstream: "web" },
  });
  expect(plan.components).toMatchObject([
    {
      name: "db",
      port: 5433,
      command: "db -p 5433",
      health: "pg_isready -h 127.0.0.1 -p 5433",
    },
    {
      name: "web",
      port: 4000,
      command: "serve --port 4000",
      health: "http://127.0.0.1:4000/health",
    },
    {
      name: "tool",
      kind: "installed",
      entrypoint: "/work/bin/tool",
    },
  ]);
  // The same config pins its ports for the Stable Target, where a pin beats an assignment.
  expect(
    resolveTargetPlan({
      config,
      target: "stable",
      ...roots_,
      assignedPorts: { web: 4000, db: 5433 },
    }).components.map((component) =>
      component.kind === "managed" ? component.port : undefined,
    ),
  ).toEqual([5432, 3000, undefined]);
  expect(() => preview({ web: 4000 })).toThrow(
    expect.objectContaining({
      code: "missing_port",
      context: { service: "db", port: "pg" },
    }),
  );
  expect(() => preview()).toThrow(
    expect.objectContaining({ code: "missing_port" }),
  );
  expect(() => preview({ web: 4000, db: 70000 })).toThrow(
    expect.objectContaining({ code: "missing_port" }),
  );
  expect(() => preview({ web: 5432, db: 5432 })).toThrow(
    expect.objectContaining({
      _tag: "ConfigError",
      code: "port_collision",
      message: "Port 5432 is used by more than one Service.",
      context: { services: ["web", "db"], port: 5432 },
    }),
  );
});

test("an auto port colliding with another Service's pin is refused for the Working copy too", () => {
  const config = parseProjectConfig({
    name: "app",
    services: {
      ...web(),
      api: { command: "api", ports: { http: "auto" } },
    },
  });
  expect(() =>
    resolveTargetPlan({
      config,
      target: "working",
      ...roots_,
      assignedPorts: { api: 3000 },
    }),
  ).toThrow(expect.objectContaining({ code: "port_collision" }));
});

test.each(["constructor", "__proto__", "toString", "rig.nope", "web.port"])(
  "reference ${%s} is unknown when the document is read, never an inherited object property",
  (key) => {
    expect(
      hintOf({ name: "app", services: web({ command: "run ${" + key + "}" }) }),
    ).toBe(
      "Fix services.web.command: Unknown reference '${" +
        key +
        "}' in services.web.command.",
    );
  },
);

test("a reference is an exact path to one public value: shell expansion, collections, targets, cycles and Project-level rig.data are refused by field", () => {
  const refusal = (extra: Record<string, unknown>) =>
    hintOf({ name: "app", services: web(), ...extra });
  expect(
    refusal({ services: web({ command: "serve --port ${PORT:-3000}" }) }),
  ).toBe(
    "Fix services.web.command: Unknown reference '${PORT:-3000}' in services.web.command.",
  );
  expect(refusal({ environment: { ALL: "${services.web.ports}" } })).toBe(
    "Fix environment.ALL: Reference '${services.web.ports}' in environment.ALL names a collection, not one value.",
  );
  expect(
    refusal({
      environment: { NAME: "${targets.stable.domain}" },
      targets: { stable: { domain: "prod.test" } },
    }),
  ).toBe(
    "Fix environment.NAME: Reference '${targets.stable.domain}' in environment.NAME reaches into targets; a reference reads the selected Target's own settings.",
  );
  expect(
    refusal({ environment: { A: "${environment.B}", B: "x${environment.A}" } }),
  ).toBe(
    "Fix environment.A: References form a cycle: environment.A -> environment.B -> environment.A; environment.B: References form a cycle: environment.B -> environment.A -> environment.B.",
  );
  // rig.data belongs to one Service, so a Tool or Project-level value cannot name it.
  expect(refusal({ environment: { DATA: "${rig.data}" } })).toBe(
    "Fix environment.DATA: ${rig.data} in environment.DATA has no Service: persistent data belongs to one Service.",
  );
  expect(
    hintOf({
      name: "app",
      tools: { ctl: { bin: "bin/ctl", build: "make DATA=${rig.data}" } },
    }),
  ).toBe(
    "Fix tools.ctl.build: ${rig.data} in tools.ctl.build has no Service: persistent data belongs to one Service.",
  );
  // A patch is checked as the graph it produces.
  expect(
    issuePaths({
      name: "app",
      services: web(),
      targets: {
        preview: { environment: { API: "${services.api.ports.http}" } },
      },
    }),
  ).toEqual(["targets.preview.environment.API"]);
});

test("references resolve through other public values, a Service's rig.data stays that Service's, and $${VAR} passes a braced shell reference through", () => {
  const plan = resolveTargetPlan({
    config: parseProjectConfig({
      name: "app",
      environment: { REGION: "eu", LITERAL: "$${HOME}/x" },
      services: {
        db: {
          command: "db --dir ${rig.data}",
          ports: { pg: 5432 },
          environment: { PGDATA: "${rig.data}/pg", URL: "pg://base" },
        },
        web: {
          command:
            'serve --db ${services.db.environment.URL} --home "$${HOME}" --user $USER',
          ports: { http: 3000 },
          environment: {
            DB: "${services.db.environment.PGDATA}",
            WHERE: "${environment.REGION}-${services.db.ports.pg}",
          },
        },
      },
      targets: {
        working: {
          services: {
            db: {
              environment: {
                URL: "pg://127.0.0.1:${services.db.ports.pg}/a b",
              },
            },
          },
        },
      },
    }),
    target: "working",
    ...roots_,
  });
  const web_ = plan.components.find((c) => c.name === "web")!;
  expect(web_).toMatchObject({
    command:
      "serve --db 'pg://127.0.0.1:5432/a b' --home \"${HOME}\" --user $USER",
    env: {
      REGION: "eu",
      LITERAL: "${HOME}/x",
      DB: "/data/db/pg",
      WHERE: "eu-5432",
    },
    // Only leaves the command was built from are guarded; WHERE and DB are not.
    commandInputs: [
      {
        name: "URL",
        source: "services.db.environment.URL",
        value: "pg://127.0.0.1:5432/a b",
      },
    ],
  });
});

test("builds resolve to units: shared first, Services in dependency order, Tools by name, never merged by shell text", () => {
  const config = parseProjectConfig({
    name: "app",
    build: "make ${environment.MODE}",
    build_timeout: "20m",
    environment: { MODE: "fast" },
    services: {
      web: {
        command: "serve",
        build: "make",
        ports: { http: 4100 },
        depends_on: ["api"],
      },
      api: {
        command: "api",
        build: "make",
        build_timeout: "90s",
        ports: { http: 4101 },
      },
      plain: { command: "plain", ports: { http: 4102 } },
    },
    tools: {
      zed: { bin: "z", build: "make" },
      ctl: { bin: "c", build: "make" },
    },
    targets: { stable: { tools: { ctl: { build_timeout: "30m" } } } },
  });
  const units = (target: "working" | "stable") =>
    resolveTargetPlan({ config, target, ...roots_ }).builds;
  expect(units("stable")).toEqual([
    {
      id: "shared",
      command: "make fast",
      timeout: 1200,
      commandInputs: [
        { name: "MODE", source: "environment.MODE", value: "fast" },
      ],
    },
    { id: "service:api", component: "api", command: "make", timeout: 90 },
    { id: "service:web", component: "web", command: "make", timeout: 1200 },
    { id: "tool:ctl", component: "ctl", command: "make", timeout: 1800 },
    { id: "tool:zed", component: "zed", command: "make", timeout: 1200 },
  ]);
  expect(units("working")!.map((unit) => unit.timeout)).toEqual([
    1200, 90, 1200, 1200, 1200,
  ]);
  // Without build_timeout the budget is ten minutes; a plan without builds records none.
  expect(
    resolveTargetPlan({
      config: parseProjectConfig({
        name: "app",
        tools: { ctl: { bin: "c", build: "make" } },
      }),
      target: "stable",
      ...roots_,
    }).builds,
  ).toEqual([
    { id: "tool:ctl", component: "ctl", command: "make", timeout: 600 },
  ]);
  expect(
    resolveTargetPlan({
      config: parseProjectConfig({ name: "app", tools: { ctl: { bin: "c" } } }),
      target: "stable",
      ...roots_,
    }).builds,
  ).toBeUndefined();
});

test.each([
  [{}, "always"],
  [{ restart: "on-failure" }, "on-failure"],
  [{ restart: "no" }, "no"],
] as const)(
  "a Service's restart policy %j is planned as %s",
  (service, restart) => {
    const plan = resolveTargetPlan({
      config: parseProjectConfig({ name: "app", services: web(service) }),
      target: "stable",
      ...roots_,
      assignedPorts: { web: 4100 },
    });
    expect(plan.components[0]).toMatchObject({ name: "web", restart });
  },
);

test("every declared port is assigned and referable, a Service may declare none, and the route map is planned longest prefix first", () => {
  const plan = resolveTargetPlan({
    config: parseProjectConfig({
      name: "app",
      domain: "app.test",
      services: {
        web: {
          command:
            "serve ${services.web.ports.http} ${services.web.ports.admin}",
          ports: { http: "auto", admin: 4200 },
        },
        api: { command: "api", ports: { http: "auto" } },
        worker: { command: "work ${services.api.ports.http}" },
      },
      proxy: {
        "/": "${services.web.ports.http}",
        "/api": "${services.api.ports.http}",
        "/api/admin/": "${services.web.ports.admin}",
      },
    }),
    target: "stable",
    ...roots_,
    // A plan saved before ports had names assigned the first port under the Service's own name.
    assignedPorts: { web: 4100, "api.http": 4300 },
  });
  expect(plan.components).toMatchObject([
    {
      name: "web",
      command: "serve 4100 4200",
      port: 4100,
      ports: { http: 4100, admin: 4200 },
    },
    { name: "api", port: 4300, ports: { http: 4300 } },
    { name: "worker", command: "work 4300" },
  ]);
  const worker = plan.components[2]!;
  expect("port" in worker || "ports" in worker).toBe(false);
  expect(plan.proxy).toEqual({
    upstream: "web",
    routes: [
      { prefix: "/api/admin", service: "web", port: 4200 },
      { prefix: "/api", service: "api", port: 4300 },
      { prefix: "/", service: "web", port: 4100 },
    ],
  });
});

test("a Preview resolved without a deployment name takes a hostname-safe name from its Branch", () => {
  const plan = resolveTargetPlan({
    config: parseProjectConfig({
      name: "app",
      domain: "app.test",
      services: web(),
      proxy: { "/": "${services.web.ports.http}" },
    }),
    target: "preview",
    branch: "Feature/X",
    ...roots_,
    assignedPorts: { web: 4100 },
  });
  expect(plan).toMatchObject({
    deploymentName: "feature-x",
    domain: "app-feature-x.test",
  });
});

test("a Preview's default hostname is the domain's first label, a dash and the Preview name, then the rest; a label over 63 characters is refused", () => {
  const plan = (domain: string, deploymentName: string, preview?: object) =>
    resolveTargetPlan({
      config: parseProjectConfig({
        name: "app",
        domain,
        services: web(),
        proxy: { "/": "${services.web.ports.http}" },
        ...(preview ? { targets: { preview } } : {}),
      }),
      target: "preview",
      deploymentName,
      ...roots_,
      assignedPorts: { web: 4100 },
    });
  expect(plan("pantry2.dev.b-relay.com", "feat-x-1a2b3c4d").domain).toBe(
    "pantry2-feat-x-1a2b3c4d.dev.b-relay.com",
  );
  expect(plan("localhost", "feat-x-1a2b3c4d").domain).toBe(
    "localhost-feat-x-1a2b3c4d",
  );
  // An explicit pattern overrides the default.
  expect(
    plan("app.test", "feat-x-1a2b3c4d", {
      domain: "${rig.target}.preview.app.test",
    }).domain,
  ).toBe("feat-x-1a2b3c4d.preview.app.test");
  const long = `${"b".repeat(40)}-1a2b3c4d`;
  expect(() => plan("pantry-recipes.app.test", long)).toThrow(
    expect.objectContaining({
      _tag: "ConfigError",
      code: "hostname_label_too_long",
      message: `Hostname 'pantry-recipes-${long}.app.test' has a 64-character label, 'pantry-recipes-${long}'; DNS allows 63.`,
      context: {
        domain: `pantry-recipes-${long}.app.test`,
        label: `pantry-recipes-${long}`,
        path: "domain",
      },
      hint: expect.stringContaining("set targets.preview.domain"),
    }),
  );
  // The same name fits under a pattern that keeps it in a label of its own.
  expect(
    plan("pantry-recipes.app.test", long, {
      domain: "${rig.target}.preview.app.test",
    }).domain,
  ).toBe(`${long}.preview.app.test`);
});

test("an env key the parser would drop silently is refused by name", () => {
  expect(
    hintOf(
      JSON.parse(
        '{"name":"app","services":{"web":{"command":"x","environment":{"__proto__":"v"}}}}',
      ),
    ),
  ).toBe(
    "Fix services.web.environment: __proto__ is not an environment variable name.",
  );
});

test.each([
  ["relative/work", "/data", "workspacePath"],
  ["/work", "relative/data", "dataRoot"],
  ["relative/work", "relative/data", "workspacePath"],
  ["", "/data", "workspacePath"],
])(
  "Target resolution rejects unsupported roots %s and %s before policy calculation",
  (workspacePath, dataRoot, field) => {
    // An unsupported build would fail if plan calculation started first.
    const config = parseProjectConfig({
      name: "app",
      build: "make",
      services: web(),
    });
    expect(() =>
      resolveTargetPlan({ config, target: "working", workspacePath, dataRoot }),
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
  const root = await fixture();
  const cwdA = join(root, "cwd one"),
    cwdB = join(root, "cwd 二");
  await Promise.all([mkdir(cwdA), mkdir(cwdB)]);
  const input = {
    config: parseProjectConfig({
      name: "app",
      environment: { ROOT: "${rig.workspace}" },
      env_file: "env/${rig.target}.env",
      services: {
        web: {
          command:
            "serve --port ${services.web.ports.http} --db ${rig.data}/数据库.sqlite",
          ports: { http: "auto" },
          depends_on: ["db"],
          environment: { DATA: "${rig.data}", URL: "${rig.url}" },
        },
        db: {
          command: "db",
          ports: { pg: "auto" },
          env_file: "env/db.env",
        },
      },
      tools: { tool: { bin: "bin/工具" } },
      proxy: { "/": "${services.web.ports.http}" },
    }),
    target: "preview" as const,
    workspacePath: "/work space/项目",
    dataRoot: "/persistent space/数据",
    branch: "feature/test",
    commit: "abc",
    deploymentName: "feature-test-0a1b2c3d",
    assignedPorts: { web: 4100, db: 5433 },
  };
  const script = `import { resolveTargetPlan } from ${JSON.stringify(join(import.meta.dir, "../src/config/index.ts"))}; process.stdout.write(JSON.stringify(resolveTargetPlan(${JSON.stringify(input)}, ${JSON.stringify(RESOLVE_HOST)})));`;
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
    "db",
    "web",
    "tool",
  ]);
  const listed = (index: number) =>
    plan.components[index]!.envFiles!.filter((file) => file.required).map(
      (file) => file.path,
    );
  expect(listed(0)).toEqual([
    "/work space/项目/env/feature-test-0a1b2c3d.env",
    "/work space/项目/env/db.env",
  ]);
  expect(plan.components[1]).toMatchObject({
    port: 4100,
    command:
      "serve --port 4100 --db '/persistent space/数据/web'/数据库.sqlite",
    env: {
      ROOT: "/work space/项目",
      DATA: "/persistent space/数据/web",
      URL: "http://127.0.0.1:4100",
    },
  });
  expect(plan.components[2]).toMatchObject({
    entrypoint: "/work space/项目/bin/工具",
  });
  expect(listed(1)).toEqual(["/work space/项目/env/feature-test-0a1b2c3d.env"]);
  expect(listed(2)).toEqual(["/work space/项目/env/feature-test-0a1b2c3d.env"]);
});

test.each([
  [
    "serve --addr 127.0.0.1:${services.server.ports.http}",
    "serve --addr 127.0.0.1:3210",
  ],
  [
    "serve --addr=localhost:${services.server.ports.http}",
    "serve --addr=localhost:3210",
  ],
  [
    'serve --addr "localhost:${services.server.ports.http}"',
    'serve --addr "localhost:3210"',
  ],
  ["serve --addr 127.0.0.1:3210", "serve --addr 127.0.0.1:3210"],
])("Target resolution accepts localhost port binding %s", (run, expected) => {
  const config = parseProjectConfig({
    name: "share",
    services: { server: { command: run, ports: { http: 3210 } } },
  });
  const plan = resolveTargetPlan({
    config,
    target: "working",
    workspacePath: "/repo",
    dataRoot: "/state/data",
  });
  expect(plan.components[0]).toMatchObject({ command: expected });
});

test("Target resolution validates the actual substituted bind values of run and ready", () => {
  const resolve = (extra: Record<string, unknown>) =>
    resolveTargetPlan({
      config: parseProjectConfig({
        name: "share",
        services: {
          server: { command: "serve", ports: { http: 3210 }, ...extra },
        },
      }),
      target: "working",
      workspacePath: "/repo",
      dataRoot: "/state/data",
    });
  expect(() =>
    resolve({ command: "serve --addr 127.0.0.1:${rig.data}" }),
  ).toThrow(
    expect.objectContaining({
      _tag: "ConfigError",
      code: "invalid_binding",
      message: "Resolved command binds outside localhost.",
      context: { service: "server" },
    }),
  );
  expect(() =>
    resolve({ ready: "probe --addr 127.0.0.1:${rig.data}" }),
  ).toThrow(
    expect.objectContaining({
      _tag: "ConfigError",
      code: "invalid_binding",
      context: { service: "server", field: "ready" },
    }),
  );
});

test("paths substituted into run, ready and build commands are shell-quoted unless the author already quoted them", () => {
  const config = parseProjectConfig({
    name: "spaced",
    services: {
      web: {
        command:
          "node ${rig.workspace}/server.js --db ${rig.data}/db.sqlite --port ${services.web.ports.http}",
        ready: "test -f ${rig.workspace}/ready",
        ports: { http: 4000 },
        environment: { DB: "${rig.data}/db.sqlite" },
      },
      api: {
        command:
          "node '${rig.workspace}/api.js' --log \"${rig.data}/log\" --port ${services.api.ports.http}",
        ready: "http://127.0.0.1:${services.api.ports.http}/",
        ports: { http: 4001 },
      },
    },
    tools: {
      tool: {
        bin: "bin/tool",
        build: "bun build ${rig.workspace}/src/tool.ts",
      },
    },
  });
  const plan = resolveTargetPlan({
    config,
    target: "working",
    workspacePath: "/repos/my app",
    dataRoot: "/state/it's data",
  });
  const web = plan.components.find((component) => component.name === "web")!;
  expect(web).toMatchObject({
    command: `node '/repos/my app'/server.js --db '/state/it'\\''s data/web'/db.sqlite --port 4000`,
    health: "test -f '/repos/my app'/ready",
    // Environment values are data, not shell text.
    env: { DB: "/state/it's data/web/db.sqlite" },
  });
  expect(
    plan.components.find((component) => component.name === "api"),
  ).toMatchObject({
    command: `node '/repos/my app/api.js' --log "/state/it's data/api/log" --port 4001`,
    health: "http://127.0.0.1:4001/",
  });
  expect(plan.builds?.find((unit) => unit.id === "tool:tool")).toMatchObject({
    command: "bun build '/repos/my app'/src/tool.ts",
  });
  const printed = Bun.spawnSync([
    "/bin/sh",
    "-c",
    `printf '%s\\n' ${web.kind === "managed" ? web.command.replace(/^node /, "") : ""}`,
  ]).stdout.toString();
  expect(printed.split("\n").filter(Boolean)).toEqual([
    "/repos/my app/server.js",
    "--db",
    "/state/it's data/web/db.sqlite",
    "--port",
    "4000",
  ]);
});

test.each([
  [
    "preview",
    { services: web({ env_file: "../shared/.env" }) },
    "services.web.env_file",
    "/shared/.env",
  ],
  ["stable", { env_file: "../shared/.env" }, "env_file", "/shared/.env"],
  [
    "preview",
    { env_file: "env/../../${rig.target}.env" },
    "env_file",
    "/pr-0a1b2c3d.env",
  ],
  ["stable", { env_file: "." }, "env_file", "/work"],
])(
  "%s Targets reject a relative env file that leaves the Target's workspace, naming the field",
  (target, extra, field, path) => {
    const config = parseProjectConfig({
      name: "app",
      services: web(),
      ...extra,
    });
    expect(() =>
      resolveTargetPlan({
        config,
        target: target as "stable" | "preview",
        ...roots_,
        branch: "main",
        commit: "abc",
        deploymentName: target === "preview" ? "pr-0a1b2c3d" : "stable",
        assignedPorts: { web: 4100 },
      }),
    ).toThrow(
      expect.objectContaining({
        _tag: "ConfigError",
        code: "path_outside_target",
        context: { field, path, root: "/work" },
        hint: expect.stringContaining(field),
      }),
    );
  },
);

test("the Working copy keeps the developer's env file wherever it is; a deployed Target keeps one inside its workspace", () => {
  const config = parseProjectConfig({
    name: "app",
    env_file: "../shared/.env",
    services: {
      ...web({ env_file: "/etc/app.env" }),
      api: { command: "api", ports: { http: 3001 } },
    },
    targets: {
      stable: {
        env_file: "env/live.env",
        services: { web: { env_file: "env/web.env" } },
      },
    },
  });
  const envFiles = (target: "working" | "stable") =>
    Object.fromEntries(
      resolveTargetPlan({ config, target, ...roots_ }).components.map(
        (component) => [
          component.name,
          (component.envFiles ?? [])
            .filter((file) => file.required)
            .map((file) => file.path),
        ],
      ),
    );
  // Project files come first and a Service's own files layer over them.
  expect(envFiles("working")).toEqual({
    web: ["/shared/.env", "/etc/app.env"],
    api: ["/shared/.env"],
  });
  expect(envFiles("stable")).toEqual({
    web: ["/work/env/live.env", "/work/env/web.env"],
    api: ["/work/env/live.env"],
  });
});

test("env_file paths resolve against the operator home or the workspace, and the resolution host must be absolute", () => {
  const config = (file: string) =>
    parseProjectConfig({ name: "app", env_file: file, services: web() });
  const input = {
    target: "working" as const,
    workspacePath: "/work",
    dataRoot: "/data",
  };
  const listed = (file: string) =>
    resolveTargetPlan({ ...input, config: config(file) }).envFiles![0];
  expect(listed("~/secrets/app.env")).toEqual({
    path: "/home/operator/secrets/app.env",
    required: true,
  });
  expect(listed("/etc/app.env").path).toBe("/etc/app.env");
  expect(listed("config/app.env").path).toBe("/work/config/app.env");
  expect(() => listed("~other/app.env")).toThrow(
    expect.objectContaining({ _tag: "ConfigError", code: "invalid_path" }),
  );
  for (const [host, field] of [
    [{ operatorHome: "home", envRoot: "/rig/env" }, "operatorHome"],
    [{ operatorHome: "/home/operator", envRoot: "env" }, "envRoot"],
  ] as const)
    expect(() =>
      resolvePlanWithHost({ ...input, config: config("a.env") }, host),
    ).toThrow(
      expect.objectContaining({ code: "relative_root", context: { field } }),
    );
});

test("a Project or Tool build cannot reach a Service's env or data, directly or through another value, and a backquoted reference is refused", () => {
  const issues = (extra: Record<string, unknown>) => {
    try {
      parseProjectConfig({
        name: "app",
        services: {
          db: {
            ...web().web,
            environment: { DATA: "${rig.data}", NAME: "db" },
          },
        },
        ...extra,
      });
    } catch (error) {
      return (error as { hint?: string }).hint;
    }
    return "accepted";
  };
  expect(
    issues({
      tools: {
        ctl: { bin: "ctl", build: "make ${services.db.environment.NAME}" },
      },
    }),
  ).toContain(
    "Fix tools.ctl.build: tools.ctl.build reaches '${services.db.environment.NAME}'",
  );
  expect(
    issues({
      environment: { VIA: "${services.db.environment.DATA}" },
      tools: { ctl: { bin: "ctl", build: "make ${environment.VIA}" } },
    }),
  ).toContain(
    "tools.ctl.build reaches '${services.db.environment.DATA}' through environment.VIA",
  );
  expect(issues({ build: "make ${services.db.environment.NAME}" })).toContain(
    "Fix build: build reaches",
  );
  // A Service may name another Service's public value.
  expect(
    issues({
      tools: { ctl: { bin: "ctl" } },
      environment: { OK: "${services.db.environment.NAME}" },
    }),
  ).toBe("accepted");
  const config = parseProjectConfig({
    name: "app",
    services: { web: { ...web().web, command: "echo `echo ${rig.target}`" } },
  });
  expect(() =>
    resolveTargetPlan({
      config,
      target: "working",
      workspacePath: "/work",
      dataRoot: "/data",
      assignedPorts: { web: 3000 },
    }),
  ).toThrow(expect.objectContaining({ code: "invalid_context" }));
});

test("YAML editing replaces or removes an uncommented mapping or sequence in place", async () => {
  const root = await fixture(),
    raw =
      "name: app # keep\nservices:\n  web:\n    command: serve\n    depends_on: [db, cache]\n  db:\n    command: postgres\n  cache:\n    command: redis\n  old:\n    command: legacy\n";
  await writeFile(join(root, "rig.yaml"), raw);
  const document = await readProjectConfig(root);
  await editProjectConfig({
    repoPath: root,
    expectedRevision: document.revision,
    edits: [
      { op: "remove", path: ["services", "old"] },
      { path: ["services", "web", "depends_on"], value: ["cache"] },
    ],
  });
  const written = await readFile(join(root, "rig.yaml"), "utf8");
  expect(written).toContain("name: app # keep");
  expect(written).not.toContain("legacy");
  expect(parse(written).services.web.depends_on).toEqual(["cache"]);
});

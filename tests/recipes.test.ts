import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  createProjectFiles,
  readProjectFile,
} from "../src/adapters/project-files";
import { renderResult } from "../src/cli/output";
import type { ProjectFiles } from "../src/cli/types";
import { renderRecipeFileModule } from "../src/recipes/file-module";
import { RECIPE_FILE_TEXT } from "../src/recipes/generated-files";
import { lineDiff } from "../src/recipes/text-diff";
import { runRigCli } from "../src/cli/rig";
import {
  editProjectConfig,
  parseProjectConfig,
  readProjectConfig,
  resolveTargetPlan,
} from "../src/config";
import type { RuntimeCommand } from "../src/daemon/protocol";
import { BUNDLED_RECIPES, type Recipe } from "../src/recipes/catalog";
import { compareRecipes } from "../src/recipes/compare";
import { createRuntime } from "../src/runtime/application";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import { FileStateStore } from "../src/runtime/state-store";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const RESOLVE_HOST = { operatorHome: "/home/operator", envRoot: "/rig/env" };
/** Project files kept in memory, for commands whose written files a test does not look at. */
function memoryFiles(): ProjectFiles {
  const files = new Map<string, string>();
  return {
    async projectDirectory(cwd) {
      return cwd;
    },
    async read(directory, path) {
      return files.get(join(directory, path));
    },
    async create(directory, path, text) {
      files.set(join(directory, path), text);
    },
  };
}

/** A recipe with a history, which no bundled recipe has yet: version 2 changed the readiness check and added a timeout. */
const CACHE: Recipe = {
  name: "cache",
  summary: "A cache for the tests.",
  defaultName: "cache",
  versions: [
    {
      version: 1,
      service: (name) => ({
        run: 'exec cached --port "$CACHE_PORT" --dir "$CACHE_DIR"',
        ports: { tcp: "auto" },
        env: {
          CACHE_PORT: `\${services.${name}.ports.tcp}`,
          CACHE_DIR: "${rig.data}/cache",
        },
        ready: `cache-ping \${services.${name}.ports.tcp}`,
      }),
    },
    {
      version: 2,
      service: (name) => ({
        run: 'exec cached --port "$CACHE_PORT" --dir "$CACHE_DIR"',
        ports: { tcp: "auto" },
        env: {
          CACHE_PORT: `\${services.${name}.ports.tcp}`,
          CACHE_DIR: "${rig.data}/cache",
        },
        ready: `cache-ping --strict \${services.${name}.ports.tcp}`,
        ready_timeout: "45s",
      }),
    },
  ],
};

/** The CLI over a real runtime that reads a real rig.yaml; nothing is supervised, routed or installed. */
async function fixture(yaml: string, recipes: readonly Recipe[] = [CACHE]) {
  const root = await mkdtemp(join(tmpdir(), "rig-recipes-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const file = join(repo, "rig.yaml");
  await writeFile(file, yaml);
  let id = 0;
  const deps = {
    root,
    recipes,
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
      readProjectFile,
      async discover(path: string) {
        return {
          repoPath: path,
          document: await readProjectConfig(path),
          gitRequired: false,
        };
      },
      async identifyInitialization(path: string) {
        return { repoPath: path, name: "demo", configPath: file };
      },
      initialize: (path: string) => readProjectConfig(path),
      resolve: (input: Parameters<typeof resolveTargetPlan>[0]) =>
        resolveTargetPlan(input, RESOLVE_HOST),
      async host() {
        return {};
      },
    },
    files: {
      async selectPorts(input: { requests: { name: string }[] }) {
        return Object.fromEntries(
          input.requests.map((request, index) => [request.name, 47000 + index]),
        );
      },
    },
    now: () => "2026-09-17T00:00:00.000Z",
    id: () => `id${++id}`,
    async diagnostic() {},
  } as unknown as RuntimeDependencies;
  const runtime = createRuntime(deps);
  await runtime.command({ action: "init", repoPath: repo });
  return {
    file,
    repo,
    runtime,
    rig: (...args: string[]) =>
      rig(args, recipes, runtime, repo, createProjectFiles()),
  };
}
async function rig(
  args: string[],
  recipes: readonly Recipe[] | undefined,
  runtime?: { command(request: RuntimeCommand): Promise<unknown> },
  cwd = "/workspace",
  projectFiles: ProjectFiles = memoryFiles(),
) {
  let out = "";
  let err = "";
  const code = await runRigCli(args, {
    root: "/isolated/.rig",
    cwd,
    projectFiles,
    ...(recipes ? { recipes } : {}),
    client: {
      async status() {
        throw new Error("status is not part of these tests");
      },
      async command(request: RuntimeCommand) {
        if (!runtime) throw new Error("this command must not need rigd");
        return runtime.command(request);
      },
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
    wait: async () => {},
    newOperationId: () => "op-1",
  });
  return { code, out, err };
}

const APP = `# The application, written by hand.
name: demo
services:
  web:
    run: bun server.js # keep this comment
    ports: {http: auto}
    env:
      PORT: \${services.web.ports.http}
`;

test("a renamed recipe resolves as ordinary config, and diff and doctor report an older, customized block without touching the file", async () => {
  const generated = await rig(
    ["recipe", "generate", "cache", "--name", "store"],
    [CACHE],
  );
  expect(generated.code).toBe(0);
  expect(generated.out).toContain(
    "  # rig-recipe: cache@2 name=store\n  store:",
  );
  expect(generated.out).not.toContain("services.cache.");

  // Pasted under `services:`, the block is config like any other: it parses and resolves on the normal path.
  const config = parseProjectConfig(parse(APP + generated.out));
  const plan = resolveTargetPlan(
    {
      config,
      target: "local",
      workspacePath: "/work",
      dataRoot: "/data",
      assignedPorts: { "web.http": 47001, "store.tcp": 47002 },
    },
    RESOLVE_HOST,
  );
  const store = plan.components.find(({ name }) => name === "store")!;
  expect(store).toMatchObject({
    kind: "managed",
    readyTimeout: 45,
    ports: { tcp: 47002 },
    env: { CACHE_PORT: "47002", CACHE_DIR: "/data/store/cache" },
    health: "cache-ping --strict 47002",
  });
  expect(config.services!.web).toEqual(
    parseProjectConfig(parse(APP)).services!.web,
  );

  // An older block the user has since changed: another port variable, and a longer timeout of their own.
  const older = (
    await rig(["recipe", "generate", "cache@1", "--name", "store"], [CACHE])
  ).out
    .replace("CACHE_DIR: ${rig.data}/cache", "CACHE_DIR: ${rig.data}/hot")
    .replace(/\n$/, "\n    ready_timeout: 90s\n");
  const f = await fixture(APP + older);
  const before = await readFile(f.file);

  const diff = await f.rig("recipe", "diff");
  expect(diff.code).toBe(0);
  expect(diff.out).toContain("store: cache@1, bundled is cache@2");
  expect(diff.out).toContain("Changed in cache@2");
  expect(diff.out).toContain(
    "ready: cache-ping --strict ${services.store.ports.tcp}",
  );
  expect(diff.out).toContain("Your changes to cache@1");
  expect(diff.out).toContain("env.CACHE_DIR: ${rig.data}/hot");
  expect(diff.out).toContain("ready_timeout: 90s");
  expect(diff.out).not.toContain("web");

  const doctor = await f.rig("doctor");
  expect(doctor.out).toContain(
    "store: generated from cache@1; cache@2 is bundled. Run rig recipe diff store to compare.",
  );
  // The notice is about configuration only, and is not a problem found.
  expect(doctor.code).toBe(0);
  expect(doctor.out).toContain("No problems found.");
  expect(await readFile(f.file)).toEqual(before);
});

test("every bundled recipe lists, generates under its own and another name without rigd, and resolves with loopback-only, application-owned inputs", async () => {
  const listed = await rig(["recipe", "list"], undefined);
  expect(listed.code).toBe(0);
  for (const recipe of BUNDLED_RECIPES) {
    expect(listed.out).toContain(
      `${recipe.name}@${recipe.versions.at(-1)!.version}  `,
    );
    for (const name of [recipe.defaultName, "renamed-1"]) {
      const block = await rig(
        ["recipe", "generate", recipe.name, "--name", name],
        undefined,
      );
      expect(block.code).toBe(0);
      const config = parseProjectConfig(parse(APP + block.out));
      const ports = Object.keys(
        (config.services![name] as { ports: Record<string, unknown> }).ports,
      );
      for (const target of ["local", "live", "preview"] as const) {
        const plan = resolveTargetPlan(
          {
            config,
            target,
            ...(target === "preview" ? { branch: "feature-a" } : {}),
            workspacePath: "/work",
            dataRoot: "/data",
            assignedPorts: {
              "web.http": 47001,
              ...Object.fromEntries(
                ports.map((port, index) => [`${name}.${port}`, 47010 + index]),
              ),
            },
          },
          RESOLVE_HOST,
        );
        const component = plan.components.find((each) => each.name === name)!;
        // Nothing the removed plugins assumed: a plain Service, no prepared component, every reference its own.
        expect(plan.preparedComponents).toEqual([]);
        expect(JSON.stringify(component)).not.toContain("${");
        expect(JSON.stringify(component)).not.toContain("0.0.0.0");
        expect(block.out).not.toMatch(/\buses\b|\bmode\b|\bprovider\b/);
        if (name !== recipe.defaultName)
          expect(block.out).not.toContain(`services.${recipe.defaultName}.`);
      }
    }
  }
  for (const [args, message] of [
    [["recipe", "generate", "sqlite"], "There is no recipe named 'sqlite'."],
    [["recipe", "generate", "postgres@9"], "postgres has no version '9'."],
    [
      ["recipe", "generate", "postgres", "--name", "Bad Name"],
      "'Bad Name' is not a Service name.",
    ],
  ] as const) {
    const refused = await rig([...args], undefined);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(message);
    expect(refused.out).toBe("");
  }
});

test("the generated PostgreSQL command reaches its programs through ordinary arguments and environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-recipes-run-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const program of ["initdb", "postgres"]) {
    await writeFile(
      join(bin, program),
      `#!/bin/sh\necho "${program} $*" >> "${root}/calls"\n[ "${program}" = initdb ] && mkdir -p "$PGDATA" && echo 17 > "$PGDATA/PG_VERSION"\nexit 0\n`,
    );
    await chmod(join(bin, program), 0o755);
  }
  const block = await rig(["recipe", "generate", "postgres"], undefined);
  const plan = resolveTargetPlan(
    {
      config: parseProjectConfig(parse(APP + block.out)),
      target: "local",
      workspacePath: root,
      dataRoot: join(root, "data with space"),
      assignedPorts: { "web.http": 47001, "db.pg": 47020 },
    },
    RESOLVE_HOST,
  );
  const db = plan.components.find(({ name }) => name === "db")!;
  if (db.kind !== "managed") throw new Error("db is a Service");
  const data = join(root, "data with space", "db", "pg");
  for (const _ of [1, 2]) {
    const run = Bun.spawn(["/bin/sh", "-c", db.command], {
      env: { ...db.env, PATH: `${bin}:/usr/bin:/bin` },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await run.exited).toBe(0);
  }
  // The cluster is created once, in the Service's persistent data, and the server is told where to listen: loopback only.
  expect((await readFile(join(root, "calls"), "utf8")).split("\n")).toEqual([
    `initdb -D ${data} -U postgres --auth=trust`,
    `postgres -D ${data} -h 127.0.0.1 -p 47020`,
    `postgres -D ${data} -h 127.0.0.1 -p 47020`,
    "",
  ]);
});

const block = async (selector: string, name: string) =>
  (await rig(["recipe", "generate", selector, "--name", name], [CACHE])).out;

test("provenance that is current, customized, renamed, unknown or malformed is each reported as what it is, and none of it stops the Project from resolving", async () => {
  const yaml =
    APP +
    (await block("cache", "current")) +
    (await block("cache", "tuned")).replace("45s", "5s") +
    (await block("cache", "first"))
      .replace("  first:", "  moved:")
      .replaceAll("services.first.", "services.moved.") +
    (await block("cache", "future")).replace("cache@2", "cache@7") +
    (await block("cache", "foreign")).replace("cache@2", "memcached@1") +
    (await block("cache", "odd")).replace("cache@2 name=odd", "cache v2") +
    (await block("cache", "twice")).replace(
      "  # rig-recipe:",
      "  # rig-recipe: cache@1 name=twice\n  # a note\n  # rig-recipe:",
    );
  const f = await fixture(yaml);
  const before = await readFile(f.file);

  const diff = await f.rig("recipe", "diff");
  expect(diff.code).toBe(0);
  expect(diff.out).toContain(
    "current: cache@2, the bundled version\n  The Service is as cache@2 generated it.",
  );
  expect(diff.out).toContain(
    "tuned: cache@2, the bundled version\n  Your changes to cache@2\n    ~ ready_timeout: 5s\n      was: 45s",
  );
  expect(diff.out).toContain(
    "moved: cache@2, the bundled version\n  Generated as 'first'; compared as 'moved'.\n  The Service is as cache@2 generated it.",
  );
  expect(diff.out).toContain(
    "future: cache@7 is a version this Rig does not bundle; nothing was compared.",
  );
  expect(diff.out).toContain(
    "foreign: memcached@1 is not a recipe bundled with this Rig; nothing was compared.",
  );
  expect(diff.out).toContain(
    "odd: the recipe comment '# rig-recipe: cache v2' is not in a form Rig writes; nothing was compared.",
  );
  expect(diff.out).toContain(
    "twice: the recipe comment '# rig-recipe: cache@1 name=twice # rig-recipe: cache@2 name=twice' is not in a form Rig writes",
  );

  const doctor = await f.rig("doctor");
  expect(doctor.code).toBe(0);
  const notices = doctor.out.slice(doctor.out.indexOf("Notices"));
  // What matches a bundled version is not news, whether or not the user changed it.
  expect(notices).not.toMatch(/current|tuned|moved/);
  expect(notices).toContain(
    "future: marked as generated from cache@7, a version this Rig does not bundle.",
  );
  expect(notices).toContain(
    "foreign: marked as generated from memcached@1, which is not a recipe bundled with this Rig.",
  );
  expect(notices).toContain(
    "odd: the recipe comment '# rig-recipe: cache v2' is not in a form Rig writes",
  );
  expect(notices).toContain("twice: the recipe comment");

  const one = await f.rig("recipe", "diff", "tuned");
  expect(one.out).toContain("tuned: cache@2");
  expect(one.out).not.toContain("current:");
  const unmarked = await f.rig("recipe", "diff", "web");
  expect(unmarked.code).toBe(1);
  expect(unmarked.err).toContain(
    "web has no rig-recipe comment, so there is nothing to compare it with.",
  );
  const absent = await f.rig("recipe", "diff", "nowhere");
  expect(absent.code).toBe(1);
  expect(absent.err).toContain("demo has no Service named 'nowhere'.");
  expect(await readFile(f.file)).toEqual(before);

  // Every Service above is planned all the same: provenance is never an input to the plan.
  const document = await readProjectConfig(join(f.file, ".."));
  const plan = resolveTargetPlan(
    {
      config: document.config,
      target: "local",
      workspacePath: "/work",
      dataRoot: "/data",
      assignedPorts: Object.fromEntries(
        Object.entries(document.config.services!).map(
          ([name, service], index) => [
            `${name}.${Object.keys((service as { ports: object }).ports)[0]}`,
            47100 + index,
          ],
        ),
      ),
    },
    RESOLVE_HOST,
  );
  expect(plan.components.map(({ name }) => name).sort()).toEqual([
    "current",
    "foreign",
    "future",
    "moved",
    "odd",
    "tuned",
    "twice",
    "web",
  ]);
  expect(JSON.stringify(plan)).not.toContain("rig-recipe");
});

test("a Project without recipe comments has nothing to compare and no notices; a structured edit elsewhere keeps the provenance comment", async () => {
  const plain = await fixture(APP);
  expect((await plain.rig("recipe", "diff")).out).toContain(
    "No Service carries a rig-recipe comment, so there is nothing to compare.",
  );
  expect((await plain.rig("doctor")).out).not.toContain("Notices");

  const f = await fixture(APP + (await block("cache@1", "store")));
  const repo = join(f.file, "..");
  const read = await readProjectConfig(repo);
  expect(read.recipeMarkers).toEqual([
    { service: "store", recipe: "cache", version: 1, name: "store" },
  ]);
  await editProjectConfig({
    repoPath: repo,
    expectedRevision: read.revision,
    edits: [{ path: ["services", "store", "ready_timeout"], value: "20s" }],
  });
  const text = await readFile(f.file, "utf8");
  expect(text).toContain("  # rig-recipe: cache@1 name=store\n  store:");
  expect(text).toContain("# keep this comment");
  expect((await readProjectConfig(repo)).recipeMarkers).toEqual(
    read.recipeMarkers,
  );
  expect((await f.rig("recipe", "diff", "store")).out).toContain(
    "  Your changes to cache@1\n    + ready_timeout: 20s",
  );
});

test("the accepted multi-Service example carries the provenance Rig writes, and its database is the bundled recipe unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-recipes-example-"));
  roots.push(root);
  await writeFile(
    join(root, "rig.yaml"),
    await readFile(join(import.meta.dir, "../docs/examples/multi.rig.yaml")),
  );
  expect(
    compareRecipes(await readProjectConfig(root), BUNDLED_RECIPES),
  ).toEqual([
    {
      service: "db",
      status: "compared",
      recipe: "postgres",
      version: 1,
      bundled: 1,
      customized: [],
      update: [],
    },
  ]);
});

test("a '# rig-recipe:' line that is a Service's shell text is not provenance, and a Service argument that is not a name is refused before it is sent or echoed", async () => {
  const yaml =
    APP.trimEnd() +
    "\n  job:\n    run: |\n      sleep 1000\n      # rig-recipe: cache@1 name=job\n" +
    (await block("cache", "store")) +
    "  tail:\n    run: sleep 1000 # rig-recipe: cache@1 name=tail\n" +
    (await block("cache", "last"));
  const f = await fixture(yaml);
  expect((await readProjectConfig(join(f.file, ".."))).recipeMarkers).toEqual([
    { service: "store", recipe: "cache", version: 2, name: "store" },
    { service: "last", recipe: "cache", version: 2, name: "last" },
  ]);

  // Text before `services`, and a flow-style map, give the first Service nothing to inherit.
  const flow = await fixture(
    APP.replace(
      /^services:[\s\S]*$/m,
      "description: |\n  # rig-recipe: cache@9 name=web\nservices: {web: {run: sleep 1000}}\n",
    ),
  );
  expect(
    (await readProjectConfig(join(flow.file, ".."))).recipeMarkers,
  ).toBeUndefined();

  const escape = String.fromCharCode(27);
  const hostile = await f.rig("recipe", "diff", `x${escape}[2J\nweb: fine`);
  expect(hostile.code).toBe(1);
  expect(hostile.err).not.toContain(escape);
  expect(hostile.err).not.toContain("\nweb: fine");
  expect(hostile.err).toContain("is not a Service name.");
});

test("a Service generated from convex@1, which cannot pass the loopback check, is steered to convex@2 by generate, diff, doctor and init, and none of them changes the file", async () => {
  const convex = BUNDLED_RECIPES.find(({ name }) => name === "convex")!;
  const notice = convex.versions.find(({ version }) => version === 1)!.notice!;
  expect(notice).toContain("LISTENER_NONLOCAL");
  expect(convex.versions.at(-1)!.version).toBe(2);

  const old = await rig(["recipe", "generate", "convex@1"], undefined);
  expect(old.code).toBe(0);
  expect(old.out).toContain("# rig-recipe: convex@1 name=convex");
  expect(old.err).toBe(
    `Warning: ${notice} Run rig recipe generate convex for convex@2.\n`,
  );
  const current = await rig(["recipe", "generate", "convex"], undefined);
  expect(current.code).toBe(0);
  expect(current.err).toBe(
    "Wrote scripts/rig-convex.ts in /workspace; commit it with the Project. The Service runs it.\n",
  );
  expect(current.out).toContain(
    "run: exec bun --no-env-file scripts/rig-convex.ts",
  );
  expect(current.out).toContain("CONVEX_STATE_DIR: ${rig.data}/backend");

  const f = await fixture(APP + old.out, BUNDLED_RECIPES);
  const before = await readFile(f.file);
  const diff = await f.rig("recipe", "diff", "convex");
  expect(diff.out).toContain(
    `convex: convex@1, bundled is convex@2\n  ${notice}\n`,
  );
  expect(diff.out).toContain("rig recipe generate convex --name convex");
  const expected = `convex: generated from convex@1; convex@2 is bundled. ${notice} Run rig recipe diff convex to compare.`;
  const doctor = await f.rig("doctor");
  expect(doctor.code).toBe(0);
  expect(doctor.out).toContain(expected);
  const init = await f.runtime.command({ action: "init", repoPath: f.repo });
  expect(init).toMatchObject({ outcome: "registered", notices: [expected] });
  expect(renderResult("init", init)).toContain(`Notice: ${expected}\n`);
  expect(await readFile(f.file)).toEqual(before);

  // A Project already on the bundled version hears nothing from init.
  const fresh = await fixture(APP + current.out, BUNDLED_RECIPES);
  expect(
    await fresh.runtime.command({ action: "init", repoPath: fresh.repo }),
  ).not.toHaveProperty("notices");
});

test("the convex@2 Service runs the Project's own helper script with bun, keeping .env files out, and its deployment in its persistent data", async () => {
  const block = (await rig(["recipe", "generate", "convex"], undefined)).out;
  const plan = resolveTargetPlan(
    {
      config: parseProjectConfig(parse(APP + block)),
      target: "live",
      workspacePath: "/checkout",
      dataRoot: "/data dir",
      assignedPorts: {
        "web.http": 47001,
        "convex.cloud": 47002,
        "convex.site": 47003,
      },
    },
    RESOLVE_HOST,
  );
  expect(plan.components.find(({ name }) => name === "convex")).toMatchObject({
    command: "exec bun --no-env-file scripts/rig-convex.ts",
    env: {
      CONVEX_CLOUD_PORT: "47002",
      CONVEX_SITE_PORT: "47003",
      CONVEX_STATE_DIR: "/data dir/convex/backend",
    },
    health: "http://127.0.0.1:47002/instance_name",
    readyTimeout: 180,
  });
});

test("generate writes the recipe's script into the Project directory once, never over a changed copy, and diff and doctor compare the Project's copy with Rig's", async () => {
  const f = await fixture(APP, BUNDLED_RECIPES);
  const nested = join(f.repo, "src", "deep");
  await mkdir(nested, { recursive: true });
  const script = join(f.repo, "scripts", "rig-convex.ts");
  const generate = () =>
    rig(
      ["recipe", "generate", "convex"],
      undefined,
      undefined,
      nested,
      createProjectFiles(),
    );

  // From anywhere in the Project, the file goes beside rig.yaml.
  const first = await generate();
  expect(first.code).toBe(0);
  expect(first.err).toContain(`Wrote scripts/rig-convex.ts in ${f.repo}`);
  expect(await readFile(script, "utf8")).toBe(
    await readFile(
      join(import.meta.dir, "../src/recipes/files/rig-convex.ts"),
      "utf8",
    ),
  );
  const again = await generate();
  expect(again.code).toBe(0);
  expect(again.err).toContain("is already convex@2's copy.");

  // Once the Project has changed it, generate still prints the block, but leaves the file and fails.
  const changed = (await readFile(script, "utf8")).replace(
    "const BACKEND_POLL_MS = 250;",
    "const BACKEND_POLL_MS = 500;",
  );
  await writeFile(script, changed);
  const refused = await generate();
  expect(refused.code).toBe(1);
  expect(refused.out).toContain("# rig-recipe: convex@2 name=convex");
  expect(refused.err).toContain(
    "scripts/rig-convex.ts in " +
      f.repo +
      " differs from convex@2's copy and was not overwritten.",
  );
  expect(refused.err).toContain("Run rig recipe diff convex to compare.");
  // The user's own file, not a fault of Rig: no diagnostic log path.
  expect(refused.err).not.toContain("Details:");
  expect(await readFile(script, "utf8")).toBe(changed);

  // The Service block is pasted; diff shows the file line by line, - the Project's and + Rig's.
  await writeFile(f.file, APP + refused.out);
  const diff = await f.rig("recipe", "diff", "convex");
  expect(diff.code).toBe(0);
  expect(diff.out).toContain(
    "  scripts/rig-convex.ts differs from convex@2's copy (- the Project's, + convex@2's):",
  );
  expect(diff.out).toContain("    -const BACKEND_POLL_MS = 500;");
  expect(diff.out).toContain("    +const BACKEND_POLL_MS = 250;");
  expect((await f.rig("doctor")).out).not.toContain("Notices");

  await rm(script);
  expect((await f.rig("recipe", "diff", "convex")).out).toContain(
    "  scripts/rig-convex.ts: not in the Project. rig recipe generate convex writes convex@2's copy.",
  );
  const doctor = await f.rig("doctor");
  expect(doctor.code).toBe(0);
  expect(doctor.out).toContain(
    "convex: scripts/rig-convex.ts, which convex@2 runs, is not in the Project. Run rig recipe generate convex to write it.",
  );
  await generate();
  expect((await f.rig("recipe", "diff", "convex")).out).toContain(
    "  scripts/rig-convex.ts: as convex@2 writes it.",
  );
});

test("the recipe files built into rig are the source files, and a recipe file path cannot leave the Project", async () => {
  expect(
    await readFile(
      join(import.meta.dir, "../src/recipes/generated-files.ts"),
      "utf8",
    ),
  ).toBe(await renderRecipeFileModule());
  expect(RECIPE_FILE_TEXT["rig-convex.ts"]).toContain("--interface");
  await expect(
    readProjectFile("/project", "../elsewhere"),
  ).rejects.toMatchObject({
    code: "RECIPE_FILE_PATH",
  });
  await expect(
    readProjectFile("/project", "/etc/passwd"),
  ).rejects.toMatchObject({
    code: "RECIPE_FILE_PATH",
  });
});

test("the line diff shows each change with its context, in unified hunks", () => {
  expect(lineDiff("a\nb\nc", "a\nb\nc")).toEqual([]);
  expect(
    lineDiff("1\n2\n3\n4\n5\n6\n7\n8\n9", "1\n2\n3\n4\nfive\n6\n7\n8\n9", 1),
  ).toEqual(["@@ -4,3 +4,3 @@", " 4", "-5", "+five", " 6"]);
  expect(lineDiff("a\nc", "a\nb\nc", 0)).toEqual(["@@ -1,0 +2,1 @@", "+b"]);
  expect(lineDiff("a\nb", "a", 0)).toEqual(["@@ -2,1 +1,0 @@", "-b"]);
});

test("a recipe file is never written through a linked directory that leads out of the Project, and a copy too long to compare still says it differs", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-recipes-links-"));
  roots.push(root);
  const project = join(root, "project");
  const elsewhere = join(root, "elsewhere");
  await mkdir(project);
  await mkdir(elsewhere);
  await symlink(elsewhere, join(project, "scripts"));
  await expect(
    createProjectFiles().create(project, "scripts/rig-convex.ts", "x"),
  ).rejects.toMatchObject({ code: "RECIPE_FILE_PATH" });
  await expect(readFile(join(elsewhere, "rig-convex.ts"))).rejects.toThrow();
  // A copy already there through the link is not the Project's either: generate refuses it rather than taking it.
  await writeFile(
    join(elsewhere, "rig-convex.ts"),
    RECIPE_FILE_TEXT["rig-convex.ts"],
  );
  const linked = await rig(
    ["recipe", "generate", "convex"],
    undefined,
    undefined,
    project,
    createProjectFiles(),
  );
  expect(linked.code).toBe(1);
  expect(linked.err).toContain(
    "The recipe file scripts/rig-convex.ts is outside the Project directory",
  );
  expect(linked.err).not.toContain("Details:");
  await expect(
    readProjectFile(project, "scripts/rig-convex.ts"),
  ).rejects.toMatchObject({ code: "RECIPE_FILE_PATH" });

  const long = Array.from({ length: 5000 }, (_, n) => `line ${n}`).join("\n");
  expect(lineDiff(long, `${long}\nmore`)).toBeUndefined();
  const f = await fixture(
    APP + (await rig(["recipe", "generate", "convex"], undefined)).out,
    BUNDLED_RECIPES,
  );
  await mkdir(join(f.repo, "scripts"));
  await writeFile(join(f.repo, "scripts", "rig-convex.ts"), long);
  expect((await f.rig("recipe", "diff", "convex")).out).toContain(
    "  scripts/rig-convex.ts differs from convex@2's copy; it is too long to show the lines.",
  );
  // Doctor only needs to know the file is there.
  expect((await f.rig("doctor")).out).not.toContain("Notices");
});

import { localActivation } from "./support/activation-doubles";
import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  stat,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTargetEffects } from "../src/adapters/target-effects";
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import { runCommand } from "../src/providers/command-runner";
import type { TargetRecord } from "../src/domain/runtime";
import type { InstalledComponent } from "../src/config/types";
import { RigError } from "../src/domain/errors";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function target(root: string): TargetRecord {
  return {
    id: "t",
    projectId: "p",
    name: "local",
    kind: "local",
    desired: "running",
    createdAt: "now",
    updatedAt: "now",
    logRoot: join(root, "logs"),
    plan: {
      project: "demo",
      target: "local",
      workspacePath: root,
      dataRoot: root,
      deploymentName: "local",
      branchSlug: "local",
      subdomain: "local",
      providers: { processSupervisor: "child" },
      components: [],
      preparedComponents: [],
    },
  };
}
/** The Tool's build unit, and the record with the Tool in its plan so the unit resolves its scope. */
function toolBuild(
  record: TargetRecord,
  component: InstalledComponent,
  command: string,
  timeout = 600,
) {
  return {
    unit: {
      id: `tool:${component.name}`,
      component: component.name,
      command,
      timeout,
    },
    record: {
      ...record,
      plan: { ...record.plan, components: [component] },
    },
  };
}
function effects(
  root: string,
  recordingTime = () => new Date().toISOString(),
  environment: Record<string, string> = {
    PATH: process.env.PATH!,
    HOST: "host",
  },
) {
  return createTargetEffects({
    ...localActivation(),
    root,
    recordingTime,
    supervisors: new Map(),
    run: runCommand,
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router: {
      async apply() {},
      async remove() {},
      async withheld() {
        return [];
      },
      async checkpoint(key) {
        return { key, value: null };
      },
      async restore() {},
    },
    environment,
  });
}
test("shared and Component builds receive their resolved environment and write raw output only to Target logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-build-env-"));
  roots.push(root);
  const record = target(root);
  const globalFile = { path: join(root, "global.env"), required: true };
  record.plan.envFiles = [globalFile];
  await writeFile(globalFile.path, "VALUE=global\n", { mode: 0o600 });
  await writeFile(join(root, "component.env"), "VALUE=component\n", {
    mode: 0o600,
  });
  const component = {
    name: "web",
    kind: "managed" as const,
    command: "serve",
    port: 3000,
    readyTimeout: 1,
    env: { OVERRIDE: "component-policy" },
    envFiles: [
      globalFile,
      { path: join(root, "component.env"), required: true },
    ],
    dependsOn: [],
  };
  record.plan.components = [component];
  const adapter = effects(root);
  await adapter.build(
    {
      id: "shared",
      command: 'printf "%s:%s\\n" "$HOST" "$VALUE"',
      timeout: 600,
    },
    record,
  );
  await adapter.build(
    {
      id: "service:web",
      component: "web",
      command: 'printf "%s:%s:%s\\n" "$HOST" "$VALUE" "$OVERRIDE"',
      timeout: 600,
    },
    record,
  );
  const entries = (await readFile(join(record.logRoot, "target.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(entries.map((entry) => entry.line)).toEqual([
    "host:global",
    `Environment name VALUE comes from ${join(root, "component.env")}, overriding ${globalFile.path}.`,
    "host:component:component-policy",
  ]);
  expect(entries[2].component).toBe("web");
});
test("a build unit runs its command once, install only publishes, and a failed rebuild keeps the usable artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-install-policy-"));
  roots.push(root);
  const adapter = effects(root);
  const component = {
    name: "tool",
    kind: "installed" as const,
    entrypoint: "tool",
    env: {},
    dependsOn: [],
  };
  const { unit, record } = toolBuild(
    target(root),
    component,
    "printf 'built\\n' >> builds; printf '#!/bin/sh\\necho ready\\n' > tool",
  );
  await adapter.build(unit, record);
  expect(await adapter.install(component, record)).toEqual({
    outcome: "installed",
  });
  // Publishing never builds; identical output is reported unchanged and left in place.
  expect(await adapter.install(component, record)).toEqual({
    outcome: "unchanged",
  });
  expect(await readFile(join(root, "builds"), "utf8")).toBe("built\n");
  await expect(
    adapter.build(
      { ...unit, command: "printf 'build failed\\n' >&2; exit 7" },
      record,
    ),
  ).rejects.toMatchObject({
    code: "BUILD_FAILED",
    details: { unit: "tool:tool", exitCode: 7 },
  });
  const entries = (await readFile(join(record.logRoot, "target.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  expect(entries).toContainEqual(
    expect.objectContaining({
      component: "tool",
      stream: "stderr",
      line: "build failed",
    }),
  );
  expect(
    (await runCommand({ command: [join(root, "bin", "tool-local")] })).stdout,
  ).toBe("ready\n");
});
test("cancelling a command health check terminates its probe process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-health-cancel-"));
  roots.push(root);
  const record = target(root),
    adapter = effects(root),
    controller = new AbortController();
  const component = {
    name: "web",
    kind: "managed" as const,
    command: "serve",
    port: 3000,
    readyTimeout: 1,
    env: {},
    dependsOn: [],
    health: "sleep 600 & echo $! > health.pid; wait",
  };
  const probe = adapter.observations.health(
    record,
    component,
    controller.signal,
  );
  let pid = 0;
  for (let i = 0; i < 50; i++) {
    pid = Number(
      await readFile(join(root, "health.pid"), "utf8").catch(() => ""),
    );
    if (pid) break;
    await Bun.sleep(20);
  }
  expect(pid).toBeGreaterThan(0);
  controller.abort();
  await expect(probe).rejects.toThrow();
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    await Bun.sleep(20);
  }
  expect(() => process.kill(pid, 0)).toThrow();
});
test("editing a local source tool keeps its shim usable without reinstalling it", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-tool-edit-"));
  roots.push(root);
  const record = target(root),
    adapter = effects(root),
    component = {
      name: "tool",
      kind: "installed" as const,
      entrypoint: "tool.ts",
      env: {},
      dependsOn: [],
    };
  await writeFile(join(root, "tool.ts"), "process.stdout.write('before')");
  expect(await adapter.install(component, record)).toEqual({
    outcome: "installed",
  });
  await writeFile(join(root, "tool.ts"), "process.stdout.write('after')");
  expect(await adapter.install(component, record)).toEqual({
    outcome: "unchanged",
  });
  expect(
    (await runCommand({ command: [join(root, "bin", "tool-local")] })).stdout,
  ).toBe("after");
  await rm(join(root, "tool.ts"));
  expect(
    await adapter.observations.artifact(
      record,
      component,
      new AbortController().signal,
    ),
  ).toBe("missing");
});
test("installed names reject another Target owner and unmanaged executables without overwriting either", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-tool-ownership-"));
  roots.push(root);
  const record = target(root),
    adapter = effects(root),
    component = {
      name: "tool",
      kind: "installed" as const,
      entrypoint: "tool.ts",
      env: {},
      dependsOn: [],
    };
  await writeFile(join(root, "tool.ts"), "process.stdout.write('first')");
  await adapter.install(component, record);
  const before = await readFile(join(root, "bin", "tool-local"), "utf8");
  await expect(
    adapter.install(component, {
      ...record,
      id: "other",
      projectId: "other-project",
    }),
  ).rejects.toMatchObject({ code: "ARTIFACT_CONFLICT" });
  expect(await readFile(join(root, "bin", "tool-local"), "utf8")).toBe(before);
  await writeFile(
    join(root, "bin", "unmanaged-local"),
    "precious unmanaged executable",
    { mode: 0o755 },
  );
  await expect(
    adapter.install({ ...component, name: "unmanaged" }, record),
  ).rejects.toMatchObject({ code: "ARTIFACT_UNOWNED" });
  expect(await readFile(join(root, "bin", "unmanaged-local"), "utf8")).toBe(
    "precious unmanaged executable",
  );
  await writeFile(join(root, "bin", "tool-local"), "outside modification");
  expect(
    await adapter.observations.artifact(
      record,
      component,
      new AbortController().signal,
    ),
  ).toBe("unknown");
});
test("setup recording acquires time for each retained line and reads unchanged streams and permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-record-time-"));
  roots.push(root);
  const record = target(root);
  const timestamps = [
    "2026-09-09T12:00:00.001Z",
    "2026-09-09T12:00:00.002Z",
    "2026-09-09T12:00:00.003Z",
    "2026-09-09T12:00:00.004Z",
  ];
  let acquired = 0;
  const adapter = effects(root, () => timestamps[acquired++]!);
  await adapter.build(
    {
      id: "shared",
      command: "printf 'one\\n\\ntwo\\n'; printf 'error\\n' >&2",
      timeout: 600,
    },
    record,
  );
  await adapter.build({ id: "shared", command: "true", timeout: 600 }, record);
  const { createRuntimeFiles } = await import("../src/adapters/runtime-files");
  const page = await createRuntimeFiles().logs(record, undefined, 100);
  expect(page.entries).toEqual([
    {
      timestamp: timestamps[0],
      component: "setup",
      stream: "stdout",
      line: "one",
    },
    {
      timestamp: timestamps[1],
      component: "setup",
      stream: "stdout",
      line: "",
    },
    {
      timestamp: timestamps[2],
      component: "setup",
      stream: "stdout",
      line: "two",
    },
    {
      timestamp: timestamps[3],
      component: "setup",
      stream: "stderr",
      line: "error",
    },
  ]);
  const { runRigCli } = await import("../src/cli/rig");
  const controller = new AbortController();
  let output = "",
    polls = 0,
    waits = 0;
  const cursors: (string | undefined)[] = [];
  const files = createRuntimeFiles();
  expect(
    await runRigCli(["logs", "local", "--follow"], {
      root,
      cwd: root,
      signal: controller.signal,
      async wait() {
        if (++waits === 2) controller.abort();
      },
      client: {
        async status() {
          throw new Error("Unexpected status");
        },
        async command(request) {
          expect(request.action).toBe("logs");
          polls++;
          cursors.push(request.after);
          return {
            project: "demo",
            target: "local",
            ...(await files.logs(record, request.after, 100)),
          };
        },
      },
      output: {
        write(value) {
          output += value;
        },
        error(value) {
          throw new Error(value);
        },
      },
      diagnostics: {
        async record() {
          return {};
        },
      },
      newOperationId: () => "recorded-follow",
    }),
  ).toBe(0);
  expect(polls).toBe(2);
  expect(cursors[0]).toBeUndefined();
  expect(typeof cursors[1]).toBe("string");
  expect(output.match(/> one/g)).toHaveLength(1);
  expect(output).toContain("! error");
  expect(record.desired).toBe("running");
  expect(acquired).toBe(4);
  expect(await readdir(record.logRoot)).toEqual(["target.jsonl"]);
  expect((await stat(record.logRoot)).mode & 0o777).toBe(0o700);
  expect((await stat(join(record.logRoot, "target.jsonl"))).mode & 0o777).toBe(
    0o600,
  );
});

test("a health URL with an uppercase scheme is probed over HTTP rather than run as a shell command", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-health-scheme-"));
  roots.push(root);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
  });
  try {
    const component = {
      name: "web",
      kind: "managed" as const,
      command: "serve",
      port: server.port!,
      readyTimeout: 1,
      env: {},
      dependsOn: [],
      health: `HTTP://127.0.0.1:${server.port}/health`,
    };
    await expect(
      effects(root).observations.health(
        target(root),
        component,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ ready: true });
  } finally {
    server.stop(true);
  }
});

test("an installation receipt survives a change in the daemon's inherited environment or an env file's contents but not in the Project's declared env", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-install-receipt-env-"));
  const operator = await mkdtemp(join(tmpdir(), "rig-install-operator-"));
  roots.push(root, operator);
  const secrets = join(operator, "all.env");
  await writeFile(secrets, "TOKEN=first\n", { mode: 0o600 });
  const record = {
    ...target(root),
    id: "live",
    kind: "live" as const,
    name: "live",
    plan: { ...target(root).plan, target: "live" as const },
  };
  const component = {
    name: "tool",
    kind: "installed" as const,
    entrypoint: "tool",
    env: { FLAVOR: "plain" },
    envFiles: [{ path: secrets, required: false }],
    dependsOn: [],
  };
  await writeFile(join(root, "tool"), "#!/bin/sh\necho ready\n");
  expect(await effects(root).install(component, record)).toEqual({
    outcome: "installed",
  });
  await writeFile(secrets, "TOKEN=rotated\n", { mode: 0o600 });
  const later = effects(root, undefined, {
    PATH: process.env.PATH!,
    TERM_SESSION_ID: "another-tab",
    HOST: "other",
  });
  expect(await later.install(component, record)).toEqual({
    outcome: "unchanged",
  });
  expect(
    await later.observations.artifact(
      record,
      component,
      new AbortController().signal,
    ),
  ).toBe("installed");
  expect(
    await later.install({ ...component, env: { FLAVOR: "spicy" } }, record),
  ).toEqual({ outcome: "installed" });
});

test("install republishes exactly when the built executable changed, on any Target", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-install-local-rebuild-"));
  roots.push(root);
  const adapter = effects(root);
  const component = {
    name: "tool",
    kind: "installed" as const,
    entrypoint: "tool",
    env: {},
    dependsOn: [],
  };
  const local = toolBuild(
    target(root),
    component,
    "cp src.txt tool; chmod +x tool",
  );
  await writeFile(join(root, "src.txt"), "#!/bin/sh\necho v1\n");
  await adapter.build(local.unit, local.record);
  expect(await adapter.install(component, local.record)).toEqual({
    outcome: "installed",
  });
  await writeFile(join(root, "src.txt"), "#!/bin/sh\necho v2\n");
  // Source the build has not consumed yet changes nothing.
  expect(await adapter.install(component, local.record)).toEqual({
    outcome: "unchanged",
  });
  await adapter.build(local.unit, local.record);
  expect(await adapter.install(component, local.record)).toEqual({
    outcome: "installed",
  });
  expect(await readFile(join(root, "bin", "tool-local"), "utf8")).toContain(
    "echo v2",
  );
  const live = {
    ...target(root),
    id: "live",
    kind: "live" as const,
    name: "live",
    plan: { ...target(root).plan, target: "live" as const },
  };
  expect(await adapter.install(component, live)).toEqual({
    outcome: "installed",
  });
  expect(await adapter.install(component, live)).toEqual({
    outcome: "unchanged",
  });
  // The Stable Target owns the plain command; the Working copy's alias carries its Target name.
  expect(await readFile(join(root, "bin", "tool"), "utf8")).toContain(
    "echo v2",
  );
});

test("a renamed Component takes over its own Target's installed executable, while another Target is still refused and told who owns it", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-install-rename-"));
  roots.push(root);
  const adapter = effects(root),
    record = target(root);
  const cli = {
    name: "cli",
    kind: "installed" as const,
    entrypoint: "tool",
    installName: "tool",
    env: {},
    dependsOn: [],
  };
  await writeFile(join(root, "tool"), "#!/bin/sh\necho ready\n");
  expect(await adapter.install(cli, record)).toEqual({ outcome: "installed" });
  const launcher = { ...cli, name: "launcher" };
  expect(await adapter.install(launcher, record)).toEqual({
    outcome: "installed",
  });
  expect(
    await adapter.observations.artifact(
      record,
      launcher,
      new AbortController().signal,
    ),
  ).toBe("installed");
  const other = {
    ...record,
    id: "other",
    plan: { ...record.plan, project: "second" },
  };
  await expect(adapter.install(cli, other)).rejects.toMatchObject({
    code: "ARTIFACT_CONFLICT",
    message: `Project 'demo' Target 'local' Component 'launcher' owns the installed executable ${join(root, "bin", "tool-local")}.`,
    hint: "Give this Component a different installName; installed executables share one bin directory across Projects and Targets.",
    details: {
      destination: join(root, "bin", "tool-local"),
      owner: {
        targetId: "t",
        componentName: "launcher",
        project: "demo",
        target: "local",
      },
    },
  });
  await writeFile(join(root, "bin", "tool-local"), "hand edit", {
    mode: 0o755,
  });
  const installed = {
    ...record,
    plan: { ...record.plan, components: [launcher] },
  };
  await expect(adapter.retireArtifacts(installed)).rejects.toMatchObject({
    code: "ARTIFACT_CHANGED",
    message: `The installed executable ${join(root, "bin", "tool-local")} changed outside its owning Component launcher.`,
    hint: `Move or delete ${join(root, "bin", "tool-local")} to keep or discard that change, then retry.`,
  });
  expect(await readFile(join(root, "bin", "tool-local"), "utf8")).toBe(
    "hand edit",
  );
  await rm(join(root, "bin", "tool-local"));
  await adapter.retireArtifacts(installed);
  expect(await Bun.file(join(root, "bin", "tool-local")).exists()).toBe(false);
  expect(
    await adapter.observations.artifact(
      installed,
      launcher,
      new AbortController().signal,
    ),
  ).toBe("missing");
});

test("a missing initdb names the tool instead of a generic start failure, and an initialised cluster is UTF8", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-postgres-missing-"));
  roots.push(root);
  const commands: (readonly string[])[] = [];
  const adapter = createTargetEffects({
    ...localActivation(),
    root,
    recordingTime: () => "now",
    supervisors: new Map(),
    run: async ({ command }) => {
      commands.push(command);
      throw new RigError(
        "COMMAND_START",
        `Provider command '${command[0]}' could not start (spawn ${command[0]} ENOENT).`,
        "Check that the executable exists and is on the PATH, and that the working directory exists.",
        { executable: command[0], cause: `spawn ${command[0]} ENOENT` },
      );
    },
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router: {
      async apply() {},
      async remove() {},
      async withheld() {
        return [];
      },
      async checkpoint(key) {
        return { key, value: null };
      },
      async restore() {},
    },
    environment: { PATH: "/nonexistent" },
  });
  const record: TargetRecord = {
    ...target(root),
    plan: {
      ...target(root).plan,
      preparedComponents: [
        { name: "pg", uses: "postgres", dataDir: join(root, "pg") },
      ],
    },
  };
  await expect(adapter.prepare(record)).rejects.toMatchObject({
    code: "POSTGRES_INIT",
    message:
      "initdb is not installed or not on rigd's PATH, so the Postgres storage for pg could not be initialized.",
    hint: "Install PostgreSQL (for example brew install postgresql@17) so initdb, postgres and pg_isready are on the PATH rigd was installed from, then retry.",
  });
  expect(commands).toEqual([
    [
      "initdb",
      "-E",
      "UTF8",
      "-A",
      "trust",
      "--no-locale",
      "-D",
      join(root, "pg"),
    ],
  ]);
});

test("dependency installation runs once per deployed revision and its marker leaves with the revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-prepare-marker-"));
  roots.push(root);
  const workspace = join(root, "targets", "p", "t", "revisions", "r1");
  const scaffold = async () => {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "package.json"), "{}\n");
  };
  await scaffold();
  const installs: string[] = [];
  const adapter = createTargetEffects({
    ...localActivation(),
    root,
    recordingTime: () => "now",
    supervisors: new Map(),
    run: async ({ command, cwd }) => {
      installs.push(`${cwd}:${command.join(" ")}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router: {
      async apply() {},
      async remove() {},
      async withheld() {
        return [];
      },
      async checkpoint(key) {
        return { key, value: null };
      },
      async restore() {},
    },
    environment: { PATH: process.env.PATH! },
  });
  const record: TargetRecord = {
    ...target(root),
    kind: "live",
    name: "live",
    sourceRoot: join(root, "targets", "p", "t", "revisions"),
    plan: { ...target(root).plan, target: "live", workspacePath: workspace },
  };
  await adapter.prepare(record);
  await adapter.prepare(record);
  expect(installs).toEqual([`${workspace}:/bin/sh -c bun install`]);
  expect(await Bun.file(join(root, "prepared")).exists()).toBe(false);
  await rm(workspace, { recursive: true, force: true });
  await scaffold();
  await adapter.prepare(record);
  expect(installs).toHaveLength(2);
});

test("a build past its budget fails as BUILD_TIMEOUT and dependency installation past its budget as DEPENDENCIES_TIMEOUT", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-build-timeout-"));
  roots.push(root);
  const { unit, record } = toolBuild(
    target(root),
    {
      name: "tool",
      kind: "installed" as const,
      entrypoint: "tool",
      env: {},
      dependsOn: [],
    },
    "echo building; sleep 30",
    1,
  );
  await expect(effects(root).build(unit, record)).rejects.toMatchObject({
    code: "BUILD_TIMEOUT",
    message: "The tool build did not finish within 1 s and was killed.",
    details: { unit: "tool:tool", timeoutSeconds: 1 },
  });
  expect(await readFile(join(root, "logs", "target.jsonl"), "utf8")).toContain(
    '"component":"tool","stream":"stdout","line":"building"',
  );
  const workspace = join(root, "targets", "p", "t", "revisions", "r1");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "package.json"), "{}\n");
  const requests: number[] = [];
  const adapter = createTargetEffects({
    ...localActivation(),
    root,
    recordingTime: () => "now",
    supervisors: new Map(),
    run: async ({ timeoutMs }) => {
      requests.push(timeoutMs!);
      return {
        exitCode: 1,
        stdout: "installing\n",
        stderr: "",
        timedOut: true,
      };
    },
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router: {
      async apply() {},
      async remove() {},
      async withheld() {
        return [];
      },
      async checkpoint(key) {
        return { key, value: null };
      },
      async restore() {},
    },
    environment: { PATH: process.env.PATH! },
  });
  const live: TargetRecord = {
    ...target(root),
    kind: "live",
    name: "live",
    sourceRoot: join(root, "targets", "p", "t", "revisions"),
    plan: {
      ...target(root).plan,
      target: "live",
      workspacePath: workspace,
      installTimeout: 7,
    },
  };
  await expect(adapter.prepare(live)).rejects.toMatchObject({
    code: "DEPENDENCIES_TIMEOUT",
    message:
      "Project dependency installation (bun install) did not finish within 7 s and was killed.",
    details: { command: "bun install", timeoutSeconds: 7 },
  });
  expect(requests).toEqual([7000]);
  expect(await readFile(join(root, "logs", "target.jsonl"), "utf8")).toContain(
    '"component":"setup","stream":"stdout","line":"installing"',
  );
});

test("a missing listed env file fails as ENV_FILE_MISSING naming the path, before any build runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-env-missing-"));
  roots.push(root);
  const record = target(root);
  record.plan.envFiles = [{ path: join(root, ".env"), required: true }];
  await expect(
    effects(root).build(
      { id: "shared", command: "touch ran", timeout: 600 },
      record,
    ),
  ).rejects.toMatchObject({
    code: "ENV_FILE_MISSING",
    message: `The environment file ${join(root, ".env")} does not exist.`,
    details: { path: join(root, ".env") },
  });
  expect(await Bun.file(join(root, "ran")).exists()).toBe(false);
});

test("an HTTP health probe treats a redirect as ready, reports a failed status, a refused connection, or a command's exit, and records each change in the Target log", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-health-evidence-"));
  roots.push(root);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/login"
        ? new Response(null, { status: 302, headers: { location: "/signin" } })
        : new Response("down", { status: 503 }),
  });
  const closed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const closedPort = closed.port!;
  closed.stop(true);
  try {
    const adapter = effects(root);
    const record = target(root);
    const probe = (health: string) =>
      adapter.observations.health(
        record,
        {
          name: "web",
          kind: "managed" as const,
          command: "serve",
          port: server.port!,
          readyTimeout: 1,
          env: {},
          dependsOn: [],
          health,
        },
        new AbortController().signal,
      );
    expect(await probe(`http://127.0.0.1:${server.port}/login`)).toEqual({
      ready: true,
    });
    expect(await probe(`http://127.0.0.1:${server.port}/down`)).toEqual({
      ready: false,
      reason: "HTTP 503",
    });
    expect(await probe(`http://127.0.0.1:${server.port}/down`)).toEqual({
      ready: false,
      reason: "HTTP 503",
    });
    expect(await probe(`http://127.0.0.1:${closedPort}/`)).toMatchObject({
      ready: false,
      reason: expect.stringMatching(/refused|connect/i),
    });
    expect(await probe("echo probing >&2; exit 3")).toEqual({
      ready: false,
      reason: "exit code 3: probing",
    });
    expect(await probe("exit 0")).toEqual({ ready: true });
    const entries = (
      await readFile(join(record.logRoot, "target.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      entries.map((entry) => [entry.component, entry.stream, entry.line]),
    ).toEqual([
      ["web", "health", "ready"],
      ["web", "health", "HTTP 503"],
      ["web", "health", expect.stringMatching(/refused|connect/i)],
      ["web", "health", "exit code 3: probing"],
      ["web", "health", "ready"],
    ]);
  } finally {
    server.stop(true);
  }
});

test("build output is recorded line by line as it arrives, with the time each line was seen", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-build-stream-"));
  roots.push(root);
  let tick = 0;
  const adapter = createTargetEffects({
    ...localActivation(),
    root,
    recordingTime: () => `t${(tick += 1)}`,
    supervisors: new Map(),
    run: async ({ onOutput }) => {
      onOutput?.("stdout", "one\ntw");
      await Bun.sleep(10);
      onOutput?.("stderr", "warned\n");
      await Bun.sleep(10);
      onOutput?.("stdout", "o\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router: {
      async apply() {},
      async remove() {},
      async withheld() {
        return [];
      },
      async checkpoint(key) {
        return { key, value: null };
      },
      async restore() {},
    },
    environment: {},
  });
  const record = target(root);
  await adapter.build({ id: "shared", command: "build", timeout: 600 }, record);
  const lines = (await readFile(join(record.logRoot, "target.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(lines).toEqual([
    { timestamp: "t1", component: "setup", stream: "stdout", line: "one" },
    { timestamp: "t2", component: "setup", stream: "stderr", line: "warned" },
    { timestamp: "t3", component: "setup", stream: "stdout", line: "two" },
  ]);
});

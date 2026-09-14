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
      providerProfile: "default",
      components: [],
      preparedComponents: [],
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
      async checkpoint(key) {
        return { key, value: null };
      },
      async restore() {},
    },
    environment,
  });
}
test("global and component hooks receive their resolved environment and write raw output only to Target logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-hook-env-"));
  roots.push(root);
  const record = target(root);
  record.plan.envFile = join(root, "global.env");
  await writeFile(record.plan.envFile, "VALUE=global\n");
  await writeFile(join(root, "component.env"), "VALUE=component\n");
  const component = {
    name: "web",
    kind: "managed" as const,
    command: "serve",
    port: 3000,
    readyTimeout: 1,
    env: { OVERRIDE: "component-policy" },
    envFile: join(root, "component.env"),
    dependsOn: [],
  };
  const adapter = effects(root);
  await adapter.hook(
    'printf "%s:%s\\n" "$HOST" "$VALUE"',
    record,
    undefined,
    "preStart",
  );
  await adapter.hook(
    'printf "%s:%s:%s\\n" "$HOST" "$VALUE" "$OVERRIDE"',
    record,
    component,
    "preStart",
  );
  const entries = (await readFile(join(record.logRoot, "target.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(entries.map((entry) => entry.line)).toEqual([
    "host:global",
    "host:component:component-policy",
  ]);
  expect(entries[1].component).toBe("web");
});
test("installed components build once per deployment and a failed replacement keeps the usable artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-install-policy-"));
  roots.push(root);
  const record = target(root),
    adapter = effects(root);
  const component = {
    name: "tool",
    kind: "installed" as const,
    entrypoint: "tool",
    build:
      "printf 'built\\n' >> builds; printf '#!/bin/sh\\necho ready\\n' > tool",
    env: {},
    dependsOn: [],
  };
  expect(await adapter.install(component, record)).toEqual({
    outcome: "installed",
  });
  // local Targets run build on every up; identical output is reported unchanged and left in place.
  expect(await adapter.install(component, record)).toEqual({
    outcome: "unchanged",
  });
  expect(await readFile(join(root, "builds"), "utf8")).toBe("built\nbuilt\n");
  await expect(
    adapter.install(
      { ...component, build: "printf 'build failed\\n' >&2; exit 7" },
      record,
    ),
  ).rejects.toThrow();
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
    (await runCommand({ command: [join(root, "bin", "tool-dev")] })).stdout,
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
    (await runCommand({ command: [join(root, "bin", "tool-dev")] })).stdout,
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
  const before = await readFile(join(root, "bin", "tool-dev"), "utf8");
  await expect(
    adapter.install(component, {
      ...record,
      id: "other",
      projectId: "other-project",
    }),
  ).rejects.toMatchObject({ code: "ARTIFACT_CONFLICT" });
  expect(await readFile(join(root, "bin", "tool-dev"), "utf8")).toBe(before);
  await writeFile(
    join(root, "bin", "unmanaged-dev"),
    "precious unmanaged executable",
    { mode: 0o755 },
  );
  await expect(
    adapter.install({ ...component, name: "unmanaged" }, record),
  ).rejects.toMatchObject({ code: "ARTIFACT_UNOWNED" });
  expect(await readFile(join(root, "bin", "unmanaged-dev"), "utf8")).toBe(
    "precious unmanaged executable",
  );
  await writeFile(join(root, "bin", "tool-dev"), "outside modification");
  expect(
    await adapter.observations.artifact(
      record,
      component,
      new AbortController().signal,
    ),
  ).toBe("unknown");
});
test("explicit artifact adoption requires the exact backed-up bytes and then permits only its owner to replace them", async () => {
  const { adoptInstalledArtifact, artifactRevision } =
    await import("../src/adapters/artifact-ownership");
  const { mkdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "rig-artifact-adoption-"));
  roots.push(root);
  const record = target(root),
    adapter = effects(root),
    component = {
      name: "tool",
      kind: "installed" as const,
      entrypoint: "tool.ts",
      env: {},
      dependsOn: [],
    },
    destination = join(root, "bin", "tool-dev");
  await mkdir(join(root, "bin"));
  await writeFile(destination, "old tool", { mode: 0o755 });
  const identity = {
    targetId: record.id,
    componentName: component.name,
    destination,
  };
  await expect(
    adoptInstalledArtifact(root, identity, "0".repeat(64)),
  ).rejects.toMatchObject({ code: "ARTIFACT_CHANGED" });
  expect(await readFile(destination, "utf8")).toBe("old tool");
  await adoptInstalledArtifact(
    root,
    identity,
    (await artifactRevision(destination))!,
  );
  await writeFile(join(root, "tool.ts"), "process.stdout.write('adopted')");
  expect(await adapter.install(component, record)).toMatchObject({
    outcome: "installed",
  });
  await expect(
    adoptInstalledArtifact(
      root,
      { ...identity, targetId: "other" },
      (await artifactRevision(destination))!,
    ),
  ).rejects.toMatchObject({ code: "ARTIFACT_CONFLICT" });
  expect((await runCommand({ command: [destination] })).stdout).toBe("adopted");
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
  await adapter.hook(
    "printf 'one\\n\\ntwo\\n'; printf 'error\\n' >&2",
    record,
    undefined,
    "preStart",
  );
  await adapter.hook("true", record, undefined, "postStart");
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
    ).resolves.toBe(true);
  } finally {
    server.stop(true);
  }
});

test("an installation receipt survives a change in the daemon's inherited environment but not in the Project's declared env", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-install-receipt-env-"));
  roots.push(root);
  // A deployed Target relies on the receipt alone; local rebuilds every time regardless.
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
    build:
      "printf 'built\\n' >> builds; printf '#!/bin/sh\\necho ready\\n' > tool",
    env: { FLAVOR: "plain" },
    dependsOn: [],
  };
  expect(await effects(root).install(component, record)).toEqual({
    outcome: "installed",
  });
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
  expect(await readFile(join(root, "builds"), "utf8")).toBe("built\nbuilt\n");
});

test("a local Target rebuilds on every install and republishes only when the build output changed; a deployed Target builds once", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-install-local-rebuild-"));
  roots.push(root);
  const adapter = effects(root);
  const component = {
    name: "tool",
    kind: "installed" as const,
    entrypoint: "tool",
    build: "printf 'built\\n' >> builds; cp src.txt tool; chmod +x tool",
    env: {},
    dependsOn: [],
  };
  await writeFile(join(root, "src.txt"), "#!/bin/sh\necho v1\n");
  const local = target(root);
  expect(await adapter.install(component, local)).toEqual({
    outcome: "installed",
  });
  await writeFile(join(root, "src.txt"), "#!/bin/sh\necho v2\n");
  expect(await adapter.install(component, local)).toEqual({
    outcome: "installed",
  });
  expect(await readFile(join(root, "bin", "tool-dev"), "utf8")).toContain(
    "echo v2",
  );
  expect(await readFile(join(root, "builds"), "utf8")).toBe("built\nbuilt\n");
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
  await writeFile(join(root, "src.txt"), "#!/bin/sh\necho v3\n");
  expect(await adapter.install(component, live)).toEqual({
    outcome: "unchanged",
  });
  expect(await readFile(join(root, "builds"), "utf8")).toBe(
    "built\nbuilt\nbuilt\n",
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
    build: "printf '#!/bin/sh\\necho ready\\n' > tool",
    env: {},
    dependsOn: [],
  };
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
  const other = { ...record, id: "other" };
  await expect(adapter.install(cli, other)).rejects.toMatchObject({
    code: "ARTIFACT_CONFLICT",
    details: {
      destination: join(root, "bin", "tool-dev"),
      owner: { targetId: "t", componentName: "launcher" },
    },
  });
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

test("a hook past its budget fails as HOOK_TIMEOUT naming the hook and budget, with its output so far in the Target logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-hook-timeout-"));
  roots.push(root);
  const record = target(root);
  record.plan.hookTimeout = 1;
  const web = {
    name: "web",
    kind: "managed" as const,
    command: "serve",
    port: 4000,
    readyTimeout: 30,
    env: {},
    dependsOn: [],
  };
  await expect(
    effects(root).hook("echo before; sleep 30", record, undefined, "preStart"),
  ).rejects.toMatchObject({
    code: "HOOK_TIMEOUT",
    message:
      "Hook preStart for the Project did not finish within 1 s and was killed.",
    details: { hook: "preStart", timeoutSeconds: 1 },
  });
  // A Component inherits the Project budget unless it sets its own.
  await expect(
    effects(root).hook("sleep 30", record, { ...web, hookTimeout: 2 }, "postStart"),
  ).rejects.toMatchObject({
    code: "HOOK_TIMEOUT",
    message: "Hook postStart for web did not finish within 2 s and was killed.",
    details: { hook: "postStart", component: "web", timeoutSeconds: 2 },
  });
  const log = await readFile(join(root, "logs", "target.jsonl"), "utf8");
  expect(log).toContain('"component":"setup","stream":"stdout","line":"before"');
});

test("a build past its budget fails as BUILD_TIMEOUT and dependency installation past its budget as DEPENDENCIES_TIMEOUT", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-build-timeout-"));
  roots.push(root);
  const record = target(root);
  await expect(
    effects(root).install(
      {
        name: "tool",
        kind: "installed" as const,
        entrypoint: "tool",
        build: "echo building; sleep 30",
        buildTimeout: 1,
        env: {},
        dependsOn: [],
      },
      record,
    ),
  ).rejects.toMatchObject({
    code: "BUILD_TIMEOUT",
    message: "The tool build did not finish within 1 s and was killed.",
    details: { component: "tool", timeoutSeconds: 1 },
  });
  expect(await readFile(join(root, "logs", "target.jsonl"), "utf8")).toContain(
    '"component":"tool","stream":"stdout","line":"building"',
  );
  const workspace = join(root, "targets", "p", "t", "revisions", "r1");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "package.json"), "{}\n");
  const requests: number[] = [];
  const adapter = createTargetEffects({
    root,
    recordingTime: () => "now",
    supervisors: new Map(),
    run: async ({ timeoutMs }) => {
      requests.push(timeoutMs!);
      return { exitCode: 1, stdout: "installing\n", stderr: "", timedOut: true };
    },
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router: {
      async apply() {},
      async remove() {},
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
    plan: { ...target(root).plan, target: "live", workspacePath: workspace, installTimeout: 7 },
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

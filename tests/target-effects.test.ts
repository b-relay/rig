import { localActivation } from "./support/activation-doubles";
import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
  stat,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTargetEffects } from "../src/adapters/target-effects";
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import { runCommand } from "../src/providers/command-runner";
import { createChildSupervisor } from "../src/providers/child-supervisor";
import {
  createProcessInspection,
  platformKill,
} from "../src/providers/process-inspection";
import { createProcessTiming } from "../src/providers/process-timing";
import { processLeasePath } from "../src/providers/process-lease";
import type { Supervisor } from "../src/providers/contracts";
import type { TargetRecord } from "../src/domain/runtime";
import type { InstalledComponent } from "../src/config/types";
import { RigError, userCorrectable } from "../src/domain/errors";
import { noRoutes } from "./support/router-doubles";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function target(root: string): TargetRecord {
  return {
    id: "t",
    projectId: "p",
    name: "working",
    kind: "working",
    desired: "running",
    createdAt: "now",
    updatedAt: "now",
    logRoot: join(root, "logs"),
    plan: {
      project: "demo",
      target: "working",
      workspacePath: root,
      dataRoot: root,
      deploymentName: "working",
      branchSlug: "working",
      subdomain: "working",
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
  tools: { readonly bun: string | undefined } = { bun: process.execPath },
) {
  return createTargetEffects({
    ...localActivation(),
    root,
    recordingTime,
    supervisors: new Map(),
    run: runCommand,
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: tools.bun,
    }),
    router: noRoutes(),
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
    (await runCommand({ command: [join(root, "bin", "tool-dev")] })).stdout,
  ).toBe("ready\n");
});
test("a Service's build and shell ready check run in its working_dir; a Tool build and a plan without one run at the workspace root", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-working-dir-"));
  roots.push(root);
  await mkdir(join(root, "apps", "web"), { recursive: true });
  const web = {
    name: "web",
    kind: "managed" as const,
    command: "serve",
    workingDir: "apps/web",
    readyTimeout: 1,
    env: {},
    dependsOn: [],
    health: "test -f built",
  };
  const tool = {
    name: "ctl",
    kind: "installed" as const,
    entrypoint: "ctl",
    env: {},
    dependsOn: [],
  };
  const record = {
    ...target(root),
    plan: { ...target(root).plan, components: [web, tool] },
  };
  const adapter = effects(root);
  const signal = new AbortController().signal;
  expect(await adapter.observations.health(record, web, signal)).toMatchObject({
    ready: false,
  });
  await adapter.build(
    {
      id: "service:web",
      component: "web",
      command: "pwd > built",
      timeout: 10,
    },
    record,
  );
  await adapter.build(
    {
      id: "tool:ctl",
      component: "ctl",
      command: "pwd > tool-built",
      timeout: 10,
    },
    record,
  );
  const real = await realpath(root);
  expect(await readFile(join(root, "apps", "web", "built"), "utf8")).toBe(
    `${join(real, "apps", "web")}\n`,
  );
  expect(await readFile(join(root, "tool-built"), "utf8")).toBe(`${real}\n`);
  expect(await adapter.observations.health(record, web, signal)).toEqual({
    ready: true,
  });
  // The same check without working_dir looks for the file at the root, where there is none.
  const { workingDir: _root, ...atRoot } = web;
  expect(
    await adapter.observations.health(record, atRoot, signal),
  ).toMatchObject({ ready: false });
});
test("a working_dir that is a symlink out of the workspace, or not there, fails before its build or check runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-working-dir-"));
  const outside = await mkdtemp(join(tmpdir(), "rig-outside-"));
  roots.push(root, outside);
  await symlink(outside, join(root, "escape"));
  const web = {
    name: "web",
    kind: "managed" as const,
    command: "serve",
    workingDir: "escape",
    readyTimeout: 1,
    env: {},
    dependsOn: [],
    health: "pwd > checked",
  };
  const record = {
    ...target(root),
    plan: { ...target(root).plan, components: [web] },
  };
  const adapter = effects(root);
  const unit = {
    id: "service:web",
    component: "web",
    command: "pwd > built",
    timeout: 10,
  };
  await expect(adapter.build(unit, record)).rejects.toMatchObject({
    code: "WORKING_DIR_OUTSIDE",
  });
  // A check reports why it is not ready rather than failing; either way it never runs outside.
  expect(
    await adapter.observations.health(
      record,
      web,
      new AbortController().signal,
    ),
  ).toMatchObject({ ready: false, reason: "WORKING_DIR_OUTSIDE" });
  expect(await readdir(outside)).toEqual([]);
  // A directory that is not there is named with its setting, not reported as a shell that could not start.
  const missing = { ...web, workingDir: "apps/missing" };
  await expect(
    adapter.build(unit, {
      ...record,
      plan: { ...record.plan, components: [missing] },
    }),
  ).rejects.toMatchObject({
    code: "WORKING_DIR_MISSING",
    hint: expect.stringContaining("services.web.working_dir"),
  });
  // Both name a setting to fix, so they are reported as the user's to correct, without diagnostic pointers.
  expect(userCorrectable("WORKING_DIR_OUTSIDE")).toBe(true);
  expect(userCorrectable("WORKING_DIR_MISSING")).toBe(true);
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
test("a source tool's shim is republished when the recorded bun changes, and one without a runnable bun keeps the last good shim", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-tool-bun-"));
  roots.push(root);
  const record = target(root),
    signal = new AbortController().signal,
    shim = join(root, "bin", "tool-dev"),
    component = {
      name: "tool",
      kind: "installed" as const,
      entrypoint: "tool.ts",
      env: {},
      dependsOn: [],
    };
  const bun = async (name: string) => {
    await mkdir(join(root, name));
    await symlink(process.execPath, join(root, name, "bun"));
    return join(root, name, "bun");
  };
  const [first, second] = [await bun("first"), await bun("second")];
  const withBun = (path: string | undefined) =>
    effects(root, undefined, undefined, { bun: path });
  await writeFile(join(root, "tool.ts"), "process.stdout.write('ran')");
  expect(await withBun(first).install(component, record)).toEqual({
    outcome: "installed",
  });
  expect(await withBun(first).install(component, record)).toEqual({
    outcome: "unchanged",
  });
  // A daemon holding another bun sees the published shim as not its own until it republishes it.
  expect(
    await withBun(second).observations.artifact(record, component, signal),
  ).toBe("unknown");
  expect(await withBun(second).install(component, record)).toEqual({
    outcome: "installed",
  });
  expect(await readFile(shim, "utf8")).toStartWith(
    `#!/bin/sh\nexec '${second}' `,
  );
  expect(
    await withBun(second).observations.artifact(record, component, signal),
  ).toBe("installed");
  await expect(
    withBun(undefined).install(component, record),
  ).rejects.toMatchObject({ code: "BUN_NOT_FOUND" });
  expect(await readFile(shim, "utf8")).toStartWith(
    `#!/bin/sh\nexec '${second}' `,
  );
  expect((await runCommand({ command: [shim] })).stdout).toBe("ran");
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
    await runRigCli(["logs", "working", "--follow"], {
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
            target: "working",
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

test("a finished HTTP check lets go of its timeout timer and of the caller's signal, whether it passed, failed or could not connect", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-health-http-timer-"));
  roots.push(root);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new Response("x", {
        status: new URL(request.url).pathname === "/up" ? 200 : 503,
      }),
  });
  const closed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const refused = closed.port!;
  closed.stop(true);
  // Every timer of an hour (the healthcheck's timeout) that is set, and every one cleared.
  const set = new Set<unknown>(),
    cleared = new Set<unknown>();
  const realSet = globalThis.setTimeout,
    realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((fire: () => void, ms?: number) => {
    const timer = realSet(fire, ms);
    if (ms === 3_600_000) set.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
    if (set.has(timer)) cleared.add(timer);
    realClear(timer);
  }) as typeof clearTimeout;
  try {
    const caller = new AbortController();
    let listeners = 0;
    const add = caller.signal.addEventListener.bind(caller.signal),
      remove = caller.signal.removeEventListener.bind(caller.signal);
    caller.signal.addEventListener = ((...args: Parameters<typeof add>) => {
      listeners++;
      add(...args);
    }) as typeof add;
    caller.signal.removeEventListener = ((
      ...args: Parameters<typeof remove>
    ) => {
      listeners--;
      remove(...args);
    }) as typeof remove;
    for (const [url, ready] of [
      [`http://127.0.0.1:${server.port}/up`, true],
      [`http://127.0.0.1:${server.port}/down`, false],
      [`http://127.0.0.1:${refused}/`, false],
    ] as const) {
      const check = await effects(root).observations.health(
        target(root),
        {
          name: "web",
          kind: "managed" as const,
          command: "serve",
          port: server.port!,
          readyTimeout: 30,
          env: {},
          dependsOn: [],
          health: url,
          healthcheck: {
            interval: 30,
            timeout: 3600,
            retries: 3,
            onFailure: "report" as const,
          },
        },
        caller.signal,
      );
      expect(check.ready).toBe(ready);
    }
    expect(set.size).toBe(3);
    expect(cleared).toEqual(set);
    expect(listeners).toBe(0);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    server.stop(true);
  }
});

test("a healthcheck's timeout bounds each HTTP check, so a late or stalled answer fails within it instead of passing or holding the start gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-health-http-timeout-"));
  roots.push(root);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      // /late answers after 1.5 s; /stalled never does.
      if (new URL(request.url).pathname === "/late") {
        await Bun.sleep(1500);
        return new Response("ok");
      }
      return await new Promise<Response>(() => {});
    },
  });
  try {
    for (const path of ["/late", "/stalled"]) {
      const component = {
        name: "web",
        kind: "managed" as const,
        command: "serve",
        port: server.port!,
        readyTimeout: 30,
        env: {},
        dependsOn: [],
        health: `http://127.0.0.1:${server.port}${path}`,
        healthcheck: {
          interval: 30,
          timeout: 1,
          retries: 3,
          onFailure: "report" as const,
        },
      };
      const started = Date.now();
      await expect(
        effects(root).observations.health(
          target(root),
          component,
          new AbortController().signal,
        ),
      ).resolves.toEqual({ ready: false, reason: "timed out after 1s" });
      expect(Date.now() - started).toBeLessThan(1400);
    }
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
    id: "stable",
    kind: "stable" as const,
    name: "stable",
    plan: { ...target(root).plan, target: "stable" as const },
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
  expect(await readFile(join(root, "bin", "tool-dev"), "utf8")).toContain(
    "echo v2",
  );
  const live = {
    ...target(root),
    id: "stable",
    kind: "stable" as const,
    name: "stable",
    plan: { ...target(root).plan, target: "stable" as const },
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
    message: `Project 'demo' Target 'working' Component 'launcher' owns the installed executable ${join(root, "bin", "tool-dev")}.`,
    hint: "Rename one of the Tools in its rig.yaml; installed executables share one bin directory across Projects and Targets.",
    details: {
      destination: join(root, "bin", "tool-dev"),
      owner: {
        targetId: "t",
        componentName: "launcher",
        project: "demo",
        target: "working",
      },
    },
  });
  await writeFile(join(root, "bin", "tool-dev"), "hand edit", {
    mode: 0o755,
  });
  const installed = {
    ...record,
    plan: { ...record.plan, components: [launcher] },
  };
  await expect(adapter.retireArtifacts(installed)).rejects.toMatchObject({
    code: "ARTIFACT_CHANGED",
    message: `The installed executable ${join(root, "bin", "tool-dev")} changed outside its owning Component launcher.`,
    hint: `Move or delete ${join(root, "bin", "tool-dev")} to keep or discard that change, then retry.`,
  });
  expect(await readFile(join(root, "bin", "tool-dev"), "utf8")).toBe(
    "hand edit",
  );
  await rm(join(root, "bin", "tool-dev"));
  await adapter.retireArtifacts(installed);
  expect(await Bun.file(join(root, "bin", "tool-dev")).exists()).toBe(false);
  expect(
    await adapter.observations.artifact(
      installed,
      launcher,
      new AbortController().signal,
    ),
  ).toBe("missing");
});
test("a Tool whose owner Target is no longer recorded is taken over by the next install, never retired by another Target, and never taken without a reader of recorded Targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-install-released-"));
  roots.push(root);
  const record = target(root);
  const tool = {
    name: "tool",
    kind: "installed" as const,
    entrypoint: "tool",
    env: {},
    dependsOn: [],
  };
  await writeFile(join(root, "tool"), "#!/bin/sh\necho first\n");
  await effects(root).install(tool, record);
  const destination = join(root, "bin", "tool-dev");
  const next = {
    ...record,
    id: "next",
    plan: { ...record.plan, components: [tool] },
  };
  // Without a reader of recorded Targets nothing is released: the old behaviour.
  await expect(effects(root).install(tool, next)).rejects.toMatchObject({
    code: "ARTIFACT_CONFLICT",
  });
  let recorded = new Set(["t"]);
  const adapter = createTargetEffects({
    ...localActivation(),
    root,
    recordingTime: () => new Date().toISOString(),
    supervisors: new Map(),
    run: runCommand,
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router: noRoutes(),
    environment: { PATH: process.env.PATH! },
    recordedTargets: async () => recorded,
  });
  // Its owner is still recorded: refused, and listed as no orphan.
  await expect(adapter.install(tool, next)).rejects.toMatchObject({
    code: "ARTIFACT_CONFLICT",
  });
  expect(await adapter.orphanedTools(async () => recorded)).toEqual([]);
  recorded = new Set(["next"]);
  expect(await adapter.orphanedTools(async () => recorded)).toEqual([
    {
      destination,
      owner: expect.objectContaining({ targetId: "t", project: "demo" }),
      changed: false,
    },
  ]);
  // Status of the Target that would take it over does not call it its own, and a retire of that Target leaves it alone.
  expect(
    await adapter.observations.artifact(
      next,
      tool,
      new AbortController().signal,
    ),
  ).toBe("unknown");
  await adapter.retireArtifacts(next);
  expect(await readFile(destination, "utf8")).toBe("#!/bin/sh\necho first\n");
  expect(await adapter.orphanedTools(async () => recorded)).toHaveLength(1);
  // The next install takes it over.
  await writeFile(join(root, "tool"), "#!/bin/sh\necho second\n");
  expect(await adapter.install(tool, next)).toEqual({ outcome: "installed" });
  expect(await readFile(destination, "utf8")).toBe("#!/bin/sh\necho second\n");
  expect(await adapter.orphanedTools(async () => recorded)).toEqual([]);
  expect(
    await adapter.observations.artifact(
      next,
      tool,
      new AbortController().signal,
    ),
  ).toBe("installed");
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
    router: noRoutes(),
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
    router: noRoutes(),
    environment: { PATH: process.env.PATH! },
  });
  const record: TargetRecord = {
    ...target(root),
    kind: "stable",
    name: "stable",
    sourceRoot: join(root, "targets", "p", "t", "revisions"),
    plan: { ...target(root).plan, target: "stable", workspacePath: workspace },
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

test("a build that leaves a process running in the background, its output redirected, has it stopped before its record goes; one that cannot be stopped fails the build and keeps the record", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rig-build-left-")));
  roots.push(root);
  const supervisor = createChildSupervisor({
    stateRoot: root,
    timing: createProcessTiming(),
    processInspection: createProcessInspection({
      run: runCommand,
      kill: platformKill,
    }),
  });
  const withSupervisor = (owner: Supervisor) =>
    createTargetEffects({
      ...localActivation(),
      root,
      recordingTime: () => new Date().toISOString(),
      supervisors: new Map([["child", owner]]),
      run: runCommand,
      installer: createArtifactInstaller({
        run: runCommand,
        bunExecutable: process.execPath,
      }),
      router: noRoutes(),
      environment: { PATH: process.env.PATH! },
    });
  const record = target(root);
  const lease = processLeasePath(root, "t:preparation:run");
  // The background sleep closes the output it inherited, so the command ends while it still runs.
  const unit = {
    id: "shared",
    command: `sleep 30 </dev/null >/dev/null 2>&1 & echo $! > '${root}/left.pid'`,
    timeout: 60,
  };
  const left = async () =>
    Number(await readFile(join(root, "left.pid"), "utf8"));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  await withSupervisor(supervisor).build(unit, record);
  expect(alive(await left())).toBe(false);
  await expect(stat(lease)).rejects.toMatchObject({ code: "ENOENT" });

  // A leftover that cannot be stopped keeps its record, so rig down still finds it.
  const stuck = {
    ...supervisor,
    disown: async () => {
      throw new Error("the group did not stop");
    },
  };
  await expect(withSupervisor(stuck).build(unit, record)).rejects.toMatchObject(
    { code: "PREPARATION_LEFTOVER" },
  );
  const pid = await left();
  expect(alive(pid)).toBe(true);
  expect((await supervisor.observe("t:preparation:run")).state).toBe("running");
  expect(await supervisor.stop("t:preparation:run", { graceMs: 1000 })).toEqual(
    { outcome: "stopped" },
  );
  expect(alive(pid)).toBe(false);
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
    router: noRoutes(),
    environment: { PATH: process.env.PATH! },
  });
  const live: TargetRecord = {
    ...target(root),
    kind: "stable",
    name: "stable",
    sourceRoot: join(root, "targets", "p", "t", "revisions"),
    plan: {
      ...target(root).plan,
      target: "stable",
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

test("a failed health command's output has every env-file value redacted before it is cut to one log line", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-health-redact-"));
  const files = await mkdtemp(join(tmpdir(), "rig-health-env-"));
  roots.push(root, files);
  const operator = join(files, "all.env");
  await writeFile(
    join(files, "web.env"),
    'API_TOKEN=tok-0123456789abcdef\nPEM="line-one-of-key\\nline-two-of-key"\nFLAG=on\nPADDED=" padded-token-012345 "\n',
    { mode: 0o600 },
  );
  await writeFile(operator, "DB_PASSWORD=hunter22\n", { mode: 0o600 });
  const record = target(root);
  const probe = (health: string) =>
    effects(root).observations.health(
      record,
      {
        name: "web",
        kind: "managed" as const,
        command: "serve",
        readyTimeout: 1,
        env: { PUBLIC_NAME: "visible-public" },
        envFiles: [
          { path: join(files, "web.env"), required: true },
          { path: operator, required: false },
        ],
        dependsOn: [],
        health,
      },
      new AbortController().signal,
    );
  // The value sits past the cut: redacted first, no prefix of it is left.
  const padding = "x".repeat(150);
  expect(await probe(`echo "${padding}$API_TOKEN" >&2; exit 2`)).toEqual({
    ready: false,
    reason: `exit code 2: ${padding}[redacted]`,
  });
  // Each line of a multi-line value, an operator file's value, and stdout too; a value too short to match only itself and
  // a public value stay.
  expect(
    await probe(
      'printf \'%s %s %s %s\\n\' "$PEM" "$DB_PASSWORD" "$FLAG" "$PUBLIC_NAME"; exit 1',
    ),
  ).toEqual({
    ready: false,
    reason: "exit code 1: [redacted] [redacted] on visible-public",
  });
  // A value with blanks around it, printed as it is or as the shell splits it unquoted: Rig trims no blank before it redacts.
  for (const health of [
    'printf "%s\\n" "$PADDED" >&2; exit 1',
    "printf '%s\\n' $PADDED >&2; exit 1",
  ])
    expect(await probe(health)).toEqual({
      ready: false,
      reason: "exit code 1: [redacted]",
    });
  // Past the 1 MiB the runner keeps, the cut can fall inside a value; the partial line is left out, whole lines stay.
  expect(
    await probe("printf '%s' \"$API_TOKEN\"; printf '%1048566s' ''; exit 1"),
  ).toEqual({ ready: false, reason: "exit code 1" });
  expect(
    await probe(
      "printf '%s' \"$API_TOKEN\"; printf '%1048566s\\nlast words\\n' ''; exit 1",
    ),
  ).toEqual({ ready: false, reason: "exit code 1: last words" });
  const logged = await readFile(join(record.logRoot, "target.jsonl"), "utf8");
  expect(logged).toContain("[redacted]");
  expect(logged).not.toMatch(
    /tok-0123|6789abcdef|hunter22|of-key|padded-token/,
  );
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
    router: noRoutes(),
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

test("a health check's answer never depends on writing its evidence: an unwritable Target log is said, and the next check writes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-health-unlogged-"));
  roots.push(root);
  const record = target(root);
  const adapter = effects(root);
  await mkdir(record.logRoot, { recursive: true });
  const log = join(record.logRoot, "target.jsonl");
  await writeFile(log, "", { mode: 0o400 });
  const web = {
    name: "web",
    kind: "managed" as const,
    command: "serve",
    readyTimeout: 1,
    env: {},
    dependsOn: [],
    health: "true",
  };
  const signal = new AbortController().signal;
  // Ongoing checks and the start gate alike.
  expect(await adapter.observations.health(record, web, signal)).toEqual({
    ready: true,
    unrecorded: expect.stringContaining("EACCES"),
  });
  expect(await adapter.health(web, record, signal)).toMatchObject({
    ready: true,
  });
  await chmod(log, 0o600);
  expect(await adapter.observations.health(record, web, signal)).toEqual({
    ready: true,
  });
  expect(await readFile(log, "utf8")).toContain('"line":"ready"');
});

test("an ongoing check of a Service's ports passes only on listeners its own process owns, at the address its route reaches", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-health-owned-"));
  roots.push(root);
  const record = target(root);
  record.plan.providers = { processSupervisor: "fake" };
  record.plan.domain = "web.test";
  record.plan.proxy = { upstream: "web" };
  const web = {
    name: "web",
    kind: "managed" as const,
    command: "serve",
    port: 4310,
    readyTimeout: 1,
    env: {},
    dependsOn: [],
  };
  record.plan.components = [web];
  // Something always answers on the port; what the Service's own process listens on changes.
  let owned: { address: string; port: number }[] = [
    { address: "127.0.0.1", port: 4310 },
  ];
  const supervisor = {
    observe: async () => ({ state: "running" as const, pid: 4242 }),
  } as unknown as Supervisor;
  const adapter = createTargetEffects({
    connect: async () => ({ ready: true }),
    listeners: {
      inspect: async (pid) => ({
        state: "observed",
        listeners: owned.map((listener) => ({ pid, ...listener })),
      }),
    },
    root,
    recordingTime: () => new Date().toISOString(),
    supervisors: new Map([["fake", supervisor]]),
    run: runCommand,
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router: noRoutes(),
    environment: { PATH: process.env.PATH! },
  });
  const check = () =>
    adapter.observations.health(record, web, new AbortController().signal);
  expect(await check()).toEqual({ ready: true });
  // The Service closed its listener and another program answers there.
  owned = [];
  expect(await check()).toEqual({
    ready: false,
    reason: "port 4310 has no listener owned by web",
  });
  // It still listens at ::1, but whoever answers at 127.0.0.1, where the route goes, is someone else.
  owned = [{ address: "::1", port: 4310 }];
  expect(await check()).toEqual({
    ready: false,
    reason:
      "web listens on port 4310 only at ::1, but Rig's proxy connects to 127.0.0.1:4310; bind it to 127.0.0.1",
  });
  owned = [{ address: "127.0.0.1", port: 4310 }];
  expect(await check()).toEqual({ ready: true });
  // The start gate inspects listeners itself, after its own check.
  owned = [];
  expect(
    await adapter.health(web, record, new AbortController().signal),
  ).toEqual({ ready: true });
});

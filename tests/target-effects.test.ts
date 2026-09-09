import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
function effects(root: string) {
  return createTargetEffects({
    root,
    supervisors: new Map(),
    run: runCommand,
    installer: createArtifactInstaller(),
    router: {
      async apply() {},
      async remove() {},
      async checkpoint(key) {
        return { key, value: null };
      },
      async restore() {},
    },
    environment: { PATH: process.env.PATH!, HOST: "host" },
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
  await adapter.hook('printf "%s:%s\\n" "$HOST" "$VALUE"', record);
  await adapter.hook(
    'printf "%s:%s:%s\\n" "$HOST" "$VALUE" "$OVERRIDE"',
    record,
    component,
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
  expect(await adapter.install(component, record)).toEqual({
    outcome: "unchanged",
  });
  expect(await readFile(join(root, "builds"), "utf8")).toBe("built\n");
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

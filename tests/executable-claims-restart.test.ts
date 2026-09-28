import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createArtifactOwnership } from "../src/adapters/artifact-ownership";
import { createTargetEffects } from "../src/adapters/target-effects";
import type { InstalledComponent } from "../src/config/types";
import type { TargetRecord } from "../src/domain/runtime";
import type { ArtifactInstaller } from "../src/providers/artifact-installer";
import type { Supervisor } from "../src/providers/contracts";
import { runCommand } from "../src/providers/command-runner";
import { createTargetLifecycle } from "../src/runtime/lifecycle";
import { localActivation } from "./support/activation-doubles";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const tool: InstalledComponent = {
  name: "tool",
  kind: "installed",
  entrypoint: "tool",
  installName: "tool",
  env: {},
  dependsOn: [],
};

/** A Stable Target of Project `project` whose one Component installs `<RIG_ROOT>/bin/tool` from its workspace. */
async function stableTarget(
  root: string,
  project: string,
): Promise<TargetRecord> {
  const workspace = join(root, "workspaces", project);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "tool"), `#!/bin/sh\necho ${project}\n`);
  return {
    id: `target-${project}`,
    projectId: project,
    name: "live",
    kind: "live",
    desired: "running",
    createdAt: "now",
    updatedAt: "now",
    logRoot: join(root, "logs", project),
    plan: {
      project,
      target: "live",
      workspacePath: workspace,
      dataRoot: join(root, "data", project),
      deploymentName: "live",
      branchSlug: "main",
      subdomain: project,
      providers: { processSupervisor: "child" },
      components: [tool],
      preparedComponents: [],
    },
  };
}

/** Copies the entrypoint to its destination. `stall` makes every install hang once it begins, as rigd dying there would. */
function installer(stall?: () => void): ArtifactInstaller {
  return {
    async install(request) {
      if (stall) {
        stall();
        return new Promise(() => {});
      }
      await mkdir(dirname(request.destination), { recursive: true });
      await writeFile(
        request.destination,
        await readFile(join(request.cwd, request.entrypoint)),
      );
      await chmod(request.destination, 0o755);
      return { path: request.destination };
    },
    async observe(path) {
      return (await Bun.file(path).exists()) ? "installed" : "missing";
    },
    shimRevision: () => undefined,
  };
}

/** One rigd's Target effects over `root`. A second call over the same root is the daemon after a restart: nothing in memory
 * survives. */
function effects(
  root: string,
  stall?: () => void,
  /** Awaited before the route checkpoint of each Target, so a test can hold an operation between its checks and writes. */
  routeCheck: (key: string) => Promise<void> = async () => {},
) {
  return createTargetEffects({
    ...localActivation(),
    root,
    recordingTime: () => "2026-09-28T12:00:00.000Z",
    // No Target here has a Service, so the supervisor is never asked anything.
    supervisors: new Map([["child", {} as Supervisor]]),
    run: runCommand,
    installer: installer(stall),
    router: {
      async apply() {},
      async remove() {},
      async withheld() {
        return [];
      },
      async checkpoint(key) {
        await routeCheck(key);
        return { key, value: null };
      },
      async restore() {},
    },
    environment: { PATH: process.env.PATH! },
  });
}
const daemon = (
  root: string,
  stall?: () => void,
  routeCheck?: (key: string) => Promise<void>,
) => createTargetLifecycle(effects(root, stall, routeCheck));
/** Rewrites Target `id`'s journal under `root` through `edit`, as another rigd version or a damaged file would leave it. */
async function editJournal(
  root: string,
  id: string,
  edit: (journal: Record<string, unknown>) => Record<string, unknown>,
) {
  const path = join(
    root,
    "effect-checkpoints",
    createHash("sha256").update(id).digest("hex"),
    "journal.json",
  );
  await writeFile(
    path,
    JSON.stringify(edit(JSON.parse(await readFile(path, "utf8")))),
  );
}

/** Target `a` begins publishing `<RIG_ROOT>/bin/tool` for the first time, and rigd dies before the write is captured. */
async function crashWhileInstalling(root: string, a: TargetRecord) {
  let stalled!: () => void;
  const reached = new Promise<void>((resolve) => (stalled = resolve));
  void daemon(root, stalled)
    .up(a)
    .catch(() => {});
  await reached;
  const checkpoint = createHash("sha256").update(a.id).digest("hex");
  const journal = JSON.parse(
    await readFile(
      join(root, "effect-checkpoints", checkpoint, "journal.json"),
      "utf8",
    ),
  );
  // The checkpoint says the write was begun, and nothing of it reached the bin directory.
  expect(journal).toMatchObject({
    targetId: a.id,
    phase: "pending",
    files: expect.arrayContaining([
      expect.objectContaining({
        path: join(root, "bin", "tool"),
        before: null,
        applying: true,
      }),
    ]),
  });
  expect(await Bun.file(join(root, "bin", "tool")).exists()).toBe(false);
}

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "rig-claims-restart-")),
  );
  roots.push(root);
  return {
    root,
    a: await stableTarget(root, "a"),
    b: await stableTarget(root, "b"),
    executable: join(root, "bin", "tool"),
    owner: (destination: string) =>
      createArtifactOwnership(root).owner(destination),
  };
}

test("after rigd restarts, another Target cannot install where a crashed Target's change was writing until that change is recovered", async () => {
  const f = await fixture();
  await crashWhileInstalling(f.root, f.a);
  const restarted = daemon(f.root);
  await expect(restarted.up(f.b)).rejects.toMatchObject({
    code: "ARTIFACT_CONFLICT",
    message: `The executable ${f.executable} belongs to an unfinished change of Project 'a' Target 'live'.`,
    details: {
      destination: f.executable,
      owner: { targetId: f.a.id, project: "a", target: "live" },
    },
  });
  expect(await Bun.file(f.executable).exists()).toBe(false);
  // rig down for the crashed Target finishes its change and hands the path back.
  await restarted.restoreEffects(f.a);
  expect(await readdir(join(f.root, "effect-checkpoints"))).toEqual([]);
  expect(await restarted.up(f.b)).toEqual({ outcome: "started" });
  expect(await readFile(f.executable, "utf8")).toBe("#!/bin/sh\necho b\n");
  expect(await f.owner(f.executable)).toMatchObject({ targetId: f.b.id });
  // A later recovery of the first Target has nothing left to undo.
  await restarted.restoreEffects(f.a);
  expect(await readFile(f.executable, "utf8")).toBe("#!/bin/sh\necho b\n");
});

test("a crashed Target's recovery refuses to remove an executable another Target has since installed at the path it was writing", async () => {
  const f = await fixture();
  await crashWhileInstalling(f.root, f.a);
  // A publication that no checkpoint claimed, as a rigd that did not read the claims on disk could have made.
  expect(await effects(f.root).install(tool, f.b)).toEqual({
    outcome: "installed",
  });
  const restarted = daemon(f.root);
  const error = await restarted.restoreEffects(f.a).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toMatchObject({
    code: "EFFECTS_CHANGED",
    details: {
      path: f.executable,
      owner: { targetId: f.b.id, project: "b", target: "live" },
    },
  });
  expect((error as { hint: string }).hint).toContain("Nothing was removed");
  expect(await readFile(f.executable, "utf8")).toBe("#!/bin/sh\necho b\n");
  expect(await f.owner(f.executable)).toMatchObject({ targetId: f.b.id });
  // The checkpoint stays, and the other Target can still free the path through its own change, as the hint says.
  expect(await readdir(join(f.root, "effect-checkpoints"))).toHaveLength(2);
  await restarted.retire(f.b);
  expect(await Bun.file(f.executable).exists()).toBe(false);
  await restarted.restoreEffects(f.a);
  expect(await readdir(join(f.root, "effect-checkpoints"))).toEqual([]);
});

test("a crashed checkpoint of a Target no longer in state does not hold the path once reconcile has pruned it", async () => {
  const f = await fixture();
  await crashWhileInstalling(f.root, f.a);
  const restarted = daemon(f.root);
  const pruned = await restarted.pruneCheckpoints(new Set([f.b.id]));
  expect(pruned).toEqual([
    expect.objectContaining({ targetId: f.a.id, outcome: "retained" }),
  ]);
  expect(await restarted.up(f.b)).toEqual({ outcome: "started" });
  expect(await f.owner(f.executable)).toMatchObject({ targetId: f.b.id });
});

test("while a crashed Target's recovery runs, another Target cannot install at a path it is about to undo, even one that Target owned at the restart", async () => {
  const f = await fixture();
  await crashWhileInstalling(f.root, f.a);
  // B owns the path when the daemon restarts, so it is not claimed for A, and B frees it through its own change.
  expect(await effects(f.root).install(tool, f.b)).toEqual({
    outcome: "installed",
  });
  let reached!: () => void;
  const atRouteCheck = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const restarted = daemon(f.root, undefined, async (key) => {
    if (key !== f.a.id) return;
    reached();
    await held;
  });
  await restarted.retire(f.b);
  // A's recovery has checked that nothing of B is left at the path and is about to remove its own half-written work.
  const recovering = restarted.restoreEffects(f.a);
  await atRouteCheck;
  await expect(restarted.up(f.b)).rejects.toMatchObject({
    code: "ARTIFACT_CONFLICT",
    details: { destination: f.executable, owner: { targetId: f.a.id } },
  });
  release();
  await recovering;
  expect(await restarted.up(f.b)).toEqual({ outcome: "started" });
  expect(await readFile(f.executable, "utf8")).toBe("#!/bin/sh\necho b\n");
  expect(await f.owner(f.executable)).toMatchObject({ targetId: f.b.id });
});

test.each([
  {
    shape: "a newer format version",
    edit: (journal: Record<string, unknown>) => ({ ...journal, version: 2 }),
  },
  {
    shape: "an invalid value",
    edit: (journal: Record<string, unknown>) => ({
      ...journal,
      phase: "later",
    }),
  },
])(
  "a crashed Target's journal with $shape, which this rigd refuses to recover, still keeps its paths after a restart",
  async ({ edit }) => {
    const f = await fixture();
    await crashWhileInstalling(f.root, f.a);
    await editJournal(f.root, f.a.id, edit);
    const restarted = daemon(f.root);
    await expect(restarted.up(f.b)).rejects.toMatchObject({
      code: "ARTIFACT_CONFLICT",
      details: { destination: f.executable, owner: { targetId: f.a.id } },
    });
    expect(await Bun.file(f.executable).exists()).toBe(false);
  },
);

test("an ownership record that cannot be read when claims are rebuilt fails the change instead of guessing, and a later change rebuilds them", async () => {
  const f = await fixture();
  await crashWhileInstalling(f.root, f.a);
  expect(await effects(f.root).install(tool, f.b)).toEqual({
    outcome: "installed",
  });
  const record = createArtifactOwnership(f.root).ownerPath(f.executable);
  await chmod(record, 0o000);
  const restarted = daemon(f.root);
  const refused = await restarted.retire(f.b).then(
    () => undefined,
    (error: unknown) => error,
  );
  await chmod(record, 0o600);
  expect(refused).toMatchObject({
    code: "ARTIFACT_OWNER",
    details: { path: record },
  });
  // Nothing was claimed on a guess: B, which owns the path, can still remove its executable.
  await restarted.retire(f.b);
  expect(await Bun.file(f.executable).exists()).toBe(false);
  await restarted.restoreEffects(f.a);
  expect(await readdir(join(f.root, "effect-checkpoints"))).toEqual([]);
});

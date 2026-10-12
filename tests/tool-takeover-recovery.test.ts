import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactOwnership } from "../src/adapters/artifact-ownership";
import { createTargetEffects } from "../src/adapters/target-effects";
import type { InstalledComponent } from "../src/config/types";
import type { TargetRecord } from "../src/domain/runtime";
import type { ArtifactInstaller } from "../src/providers/artifact-installer";
import type { Supervisor } from "../src/providers/contracts";
import { runCommand } from "../src/providers/command-runner";
import { localActivation } from "./support/activation-doubles";
import { noRoutes } from "./support/router-doubles";

// A takeover of a released Tool (#343) that rigd dies in the middle of must be undone by its own recovery: the ownership
// record still naming the released owner is where the change started, not a later owner that recovery must not touch.

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

/** A stable Target `id` whose one Tool publishes `<root>/bin/tool` from a workspace holding `bytes`. */
async function stableTarget(
  root: string,
  id: string,
  bytes: string,
): Promise<TargetRecord> {
  const workspace = join(root, "workspaces", id);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "tool"), bytes);
  return {
    id,
    projectId: id,
    name: "stable",
    kind: "stable",
    desired: "stopped",
    createdAt: "now",
    updatedAt: "now",
    logRoot: join(root, "logs", id),
    plan: {
      project: id,
      target: "stable",
      workspacePath: workspace,
      dataRoot: join(root, "data", id),
      deploymentName: "stable",
      branchSlug: "main",
      subdomain: id,
      providers: { processSupervisor: "child" },
      components: [tool],
      preparedComponents: [],
    },
  };
}

const copying: ArtifactInstaller = {
  async install(request) {
    await writeFile(
      request.destination,
      await readFile(join(request.cwd, request.entrypoint)),
      { mode: 0o755 },
    );
    return { path: request.destination };
  },
  async observe(path) {
    return (await Bun.file(path).exists()) ? "installed" : "missing";
  },
  shimRevision: () => undefined,
};

/** rigd after a restart, over `root`, with `recorded` the Target ids state records. */
function restarted(root: string, recorded: readonly string[]) {
  return createTargetEffects({
    ...localActivation(),
    root,
    recordingTime: () => "2026-10-11T12:00:00.000Z",
    supervisors: new Map([["child", {} as Supervisor]]),
    run: runCommand,
    installer: copying,
    router: noRoutes(),
    environment: { PATH: process.env.PATH! },
    recordedTargets: async () => new Set(recorded),
  });
}

for (const point of ["before", "rename", "owner"] as const) {
  test(`a takeover of a released Tool that rigd dies in (${point}) is rolled back by its own recovery, and no other Target takes the path meanwhile`, async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-takeover-crash-"));
    roots.push(root);
    const destination = join(root, "bin", "tool");
    const original = "#!/bin/sh\necho forgotten\n";
    // A Tool a forgotten Project published: its owner `gone` is in no state record.
    await mkdir(join(root, "bin"), { recursive: true });
    await createArtifactOwnership(root).publish(
      {
        targetId: "gone",
        componentName: "tool",
        destination,
        project: "gone",
        target: "stable",
      },
      () => writeFile(destination, original, { mode: 0o755 }),
    );
    const ownerFile = join(
      root,
      "installed",
      "owners",
      createHash("sha256").update(destination).digest("hex") + ".json",
    );
    const originalOwner = await readFile(ownerFile, "utf8");
    const next = await stableTarget(root, "next", "#!/bin/sh\necho next\n");
    const targetFile = join(root, "next.json");
    await writeFile(targetFile, JSON.stringify(next));
    // The rigd taking it over is a real process, killed at `point`.
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "support", "interrupted-takeover.ts"),
        root,
        targetFile,
        point,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await child.exited;
    if (exitCode !== 9)
      throw new Error(
        `the interrupted takeover exited ${exitCode}: ${await new Response(child.stderr).text()}`,
      );
    if (point === "rename")
      expect(await readFile(destination, "utf8")).toBe(
        "#!/bin/sh\necho next\n",
      );
    if (point !== "owner")
      expect(await readFile(ownerFile, "utf8")).toBe(originalOwner);
    const effects = restarted(root, ["next", "other"]);
    // Until its recovery runs, the unfinished change still holds the path.
    const other = await stableTarget(root, "other", "#!/bin/sh\necho other\n");
    await expect(effects.checkpoint(other)).rejects.toMatchObject({
      code: "ARTIFACT_CONFLICT",
      message: expect.stringContaining("unfinished change"),
    });
    // rig down's recovery rolls the takeover back: the released Tool and its record are as they were.
    await effects.restoreEffects(next);
    expect(await readFile(destination, "utf8")).toBe(original);
    expect(await readFile(ownerFile, "utf8")).toBe(originalOwner);
    // And the takeover runs to its end the next time.
    const checkpoint = await effects.checkpoint(next);
    expect(await effects.install(tool, next)).toEqual({
      outcome: "installed",
    });
    await checkpoint.commit();
    expect(await readFile(destination, "utf8")).toBe("#!/bin/sh\necho next\n");
    expect(JSON.parse(await readFile(ownerFile, "utf8")).targetId).toBe("next");
  });
}

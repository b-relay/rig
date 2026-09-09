import { test, expect } from "bun:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { rigFixture } from "./support/rig-fixture";
import {
  readLegacyState,
  migrateLegacyState,
  readLegacyAdoption,
  finalizeLegacyAdoption,
  createAdoptionGuard,
} from "../src/migration";
import { createGitSourceStore } from "../src/providers/git-source-store";
import {
  adoptInstalledArtifact,
  artifactRevision,
} from "../src/adapters/artifact-ownership";

test("legacy migration, explicit ownership and real daemon preserve recorded source, storage and old bytes", async () => {
  const f = await rigFixture();
  try {
    const port = await vacantPort(),
      workspace = join(f.root, "workspaces", "demo", "live"),
      data = join(f.root, "data", "demo", "live"),
      logs = join(f.root, "logs", "demo", "live");
    const command = `'${process.execPath}' app.ts`;
    await writeFile(
      join(f.repo, "app.ts"),
      "const server=Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response('preserved')});process.stdout.write('new capture\\n')",
    );
    await writeFile(
      join(f.repo, "tool.ts"),
      "process.stdout.write('installed tool\\n')",
    );
    await writeFile(
      join(f.repo, "rig.json"),
      JSON.stringify({
        name: "demo",
        components: {
          web: { mode: "managed", command, port, env: { PORT: String(port) } },
          tool: { mode: "installed", entrypoint: "tool.ts" },
        },
      }),
    );
    await f.git(["init", "-b", "main"]);
    const commit = await f.commit();
    await createGitSourceStore({ root: join(f.root, "sources") }).prepare({
      project: "demo",
      repository: f.repo,
      ref: commit,
      destination: workspace,
    });
    await mkdir(data, { recursive: true });
    await writeFile(
      join(data, "preserved.sqlite"),
      "original database fixture bytes",
    );
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, "web.launchd.log"), "old combined output\n");
    const plan = {
      project: "demo",
      lane: "live",
      deploymentName: "live",
      branchSlug: "live",
      subdomain: "live",
      workspacePath: workspace,
      dataRoot: data,
      providerProfile: "default",
      providers: { processSupervisor: "rigd" },
      components: [
        {
          name: "web",
          kind: "managed",
          command,
          port,
          env: { PORT: String(port) },
          readyTimeout: 3,
          health: `http://127.0.0.1:${port}`,
        },
        { name: "tool", kind: "installed", entrypoint: "tool.ts" },
      ],
      preparedComponents: [],
    };
    const record = {
      project: "demo",
      kind: "live",
      name: "live",
      sourceRef: "main",
      sourceCommit: commit,
      branchSlug: "live",
      subdomain: "live",
      workspacePath: workspace,
      dataRoot: data,
      logRoot: logs,
      runtimeRoot: join(f.root, "runtime", "demo", "live"),
      runtimeStatePath: join(f.root, "runtime", "demo", "live", "runtime.json"),
      assignedPorts: { web: port },
      providerProfile: "default",
      resolved: {
        ...plan,
        sourceRepoPath: f.repo,
        runtimePlan: plan,
        environment: { services: [] },
        v1Config: { daemon: { keepAlive: false } },
      },
    };
    const original = JSON.stringify({
      version: 1,
      events: [
        {
          timestamp: "2026-09-01T00:00:00Z",
          event: "rigd.project.registered",
          project: "demo",
          details: { repoPath: f.repo, configPath: join(f.repo, "rig.json") },
        },
      ],
      receipts: [],
      healthSummaries: [],
      providerObservations: [],
      portReservations: [],
      deploymentSnapshots: [],
      managedServiceFailures: [],
      desiredDeployments: [
        {
          project: "demo",
          deployment: "live",
          kind: "live",
          desiredStatus: "stopped",
          updatedAt: "2026-09-01T00:00:00Z",
          providerProfile: "default",
          record,
        },
      ],
    });
    await mkdir(join(f.root, "runtime"), { recursive: true });
    const legacyPath = join(f.root, "runtime", "rigd-state.json");
    await writeFile(legacyPath, original);
    const preview = await readLegacyState(f.root);
    expect(preview.issues).toEqual([]);
    await migrateLegacyState(f.root, { expectedRevision: preview.revision });
    await expect(createAdoptionGuard(f.root)()).rejects.toMatchObject({
      code: "LEGACY_ADOPTION_PENDING",
    });
    const target = preview.state!.targets[0]!;
    const destination = join(f.root, "bin", "tool");
    await mkdir(join(f.root, "bin"));
    await writeFile(destination, "#!/bin/sh\necho old tool\n", { mode: 0o755 });
    await adoptInstalledArtifact(
      f.root,
      { targetId: target.id, componentName: "tool", destination },
      (await artifactRevision(destination))!,
    );
    const pending = await readLegacyAdoption(f.root);
    expect(pending).toBeDefined();
    await finalizeLegacyAdoption(f.root, {
      expectedRevision: pending!.revision,
      evidence: {
        verifiedAt: new Date().toISOString(),
        processes: preview.adoption.processes.map((owner) => ({
          key: owner.key,
          provider: owner.provider,
          legacyLabel: owner.legacyLabel,
          outcome: "verified-absent",
          previousOwner: "absent",
          observedAt: new Date().toISOString(),
        })),
        routes: [],
      },
    });
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(
      await f.rig(["up", "live", "--project", "demo"], f.base),
    ).toMatchObject({ code: 0 });
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe(
      "preserved",
    );
    expect(await f.run([destination])).toMatchObject({
      code: 0,
      stdout: "installed tool\n",
    });
    const logText = (await f.rig(["logs", "live", "--project", "demo"], f.base))
      .stdout;
    expect(logText).toContain("old combined output");
    expect(logText).toContain("new capture");
    expect(await readFile(join(data, "preserved.sqlite"), "utf8")).toBe(
      "original database fixture bytes",
    );
    expect(await readFile(legacyPath, "utf8")).toBe(original);
    expect(
      await f.rig(["down", "live", "--project", "demo"], f.base),
    ).toMatchObject({ code: 0 });
    expect(await f.rigd(["uninstall"])).toMatchObject({ code: 0 });
  } finally {
    await f.cleanup();
  }
}, 30000);
async function vacantPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

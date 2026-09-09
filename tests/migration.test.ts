import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readLegacyState,
  createAdoptionGuard,
  readLegacyAdoption,
  finalizeLegacyAdoption,
  migrateLegacyState as publishLegacyState,
} from "../src/migration/index";
const roots: string[] = [];
async function migrateLegacyState(root: string) {
  return publishLegacyState(root, {
    expectedRevision: (await readLegacyState(root)).revision,
  });
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rig-migration-"));
  roots.push(root);
  await mkdir(join(root, "runtime"));
  await mkdir(join(root, "developer"));
  await writeFile(
    join(root, "developer", "rig.json"),
    JSON.stringify({ name: "app", components: {} }),
  );
  return root;
}
function legacy(root: string) {
  const workspace = join(root, "workspaces", "app", "live");
  const plan = {
    project: "app",
    lane: "live",
    deploymentName: "live",
    branchSlug: "live",
    subdomain: "live",
    workspacePath: workspace,
    dataRoot: join(root, "data", "app", "live"),
    providerProfile: "default",
    providers: { processSupervisor: "launchd" },
    components: [
      {
        name: "web",
        kind: "managed",
        command: "serve --host localhost",
        port: 3210,
        readyTimeout: 30,
      },
    ],
    preparedComponents: [],
    domain: "app.example.test",
    proxy: { upstream: "web" },
  };
  const record = {
    project: "app",
    kind: "live",
    name: "live",
    sourceRef: "main",
    sourceCommit: "a".repeat(40),
    branchSlug: "live",
    subdomain: "live",
    workspacePath: workspace,
    dataRoot: plan.dataRoot,
    logRoot: join(root, "logs", "app", "live"),
    runtimeRoot: join(root, "runtime", "app", "live"),
    runtimeStatePath: join(root, "runtime", "app", "live", "runtime.json"),
    assignedPorts: { web: 3210 },
    providerProfile: "default",
    resolved: {
      ...plan,
      sourceRepoPath: join(root, "developer"),
      runtimePlan: plan,
      environment: {
        services: [
          {
            name: "web",
            type: "server",
            command: "serve --host localhost",
            port: 3210,
          },
        ],
      },
      v1Config: { name: "app", version: "0.0.0", environments: {} },
    },
  };
  return {
    version: 1,
    events: [
      {
        timestamp: "2026-09-01T00:00:00Z",
        event: "rigd.project.registered",
        project: "app",
        details: {
          repoPath: join(root, "developer"),
          configPath: join(root, "developer", "rig.json"),
        },
      },
    ],
    receipts: [
      {
        id: "accepted-only",
        kind: "deploy",
        accepted: true,
        project: "app",
        stateRoot: root,
        target: "live",
        receivedAt: "2026-09-01T00:00:00Z",
      },
    ],
    healthSummaries: [],
    providerObservations: [],
    portReservations: [],
    deploymentSnapshots: [],
    desiredDeployments: [
      {
        project: "app",
        deployment: "live",
        kind: "live",
        desiredStatus: "running",
        updatedAt: "2026-09-01T00:00:00Z",
        providerProfile: "default",
        record,
      },
    ],
    managedServiceFailures: [],
  };
}
test("legacy preview converts recorded policy without changing any source bytes or pretending adoption is complete", async () => {
  const root = await fixture(),
    raw = JSON.stringify(legacy(root), null, 2) + "\n",
    path = join(root, "runtime", "rigd-state.json");
  await writeFile(path, raw);
  const preview = await readLegacyState(root);
  expect(preview.issues).toEqual([]);
  expect(preview.state?.targets[0]).toMatchObject({
    name: "live",
    kind: "live",
    branch: "main",
    commit: "a".repeat(40),
    desired: "running",
    plan: {
      providers: { processSupervisor: "launchd" },
      components: [
        {
          name: "web",
          command: "serve --host localhost",
          env: {},
          dependsOn: [],
        },
      ],
    },
  });
  expect(preview.adoption.processes[0]).toMatchObject({
    legacyLabel: "com.b-relay.rig.app.live.web",
    status: "requires-adoption",
  });
  expect(preview.adoption.routes[0]).toMatchObject({
    legacyMarker: "# [rig:app:live:web]",
    hostname: "app.example.test",
    status: "requires-adoption",
  });
  expect(
    preview.state?.activity.some((event) => event.id === "accepted-only"),
  ).toBe(false);
  expect(await readFile(path, "utf8")).toBe(raw);
});

test("explicit metadata migration backs up exact source bytes, preserves originals, and cannot overwrite new state", async () => {
  const root = await fixture(),
    path = join(root, "runtime", "rigd-state.json"),
    raw = JSON.stringify(legacy(root), null, 2) + "\n";
  await writeFile(path, raw);
  const result = await migrateLegacyState(root);
  await expect(createAdoptionGuard(root)()).rejects.toThrow("pending");
  const adoption = (await readLegacyAdoption(root))!;
  await finalizeLegacyAdoption(root, {
    expectedRevision: adoption.revision,
    evidence: {
      verifiedAt: "2026-09-09T12:00:01Z",
      processes: adoption.manifest.adoption.processes.map((owner) => ({
        key: owner.key,
        provider: owner.provider,
        legacyLabel: owner.legacyLabel,
        outcome: "replaced" as const,
        previousOwner: owner.legacyLabel
          ? ("unloaded" as const)
          : ("absent" as const),
        currentKey: owner.key,
        observedAt: "2026-09-09T12:00:00Z",
      })),
      routes: adoption.manifest.adoption.routes.map((owner) => ({
        key: owner.key,
        legacyMarker: owner.legacyMarker,
        outcome: "adopted" as const,
        currentKey: owner.key,
        observedAt: "2026-09-09T12:00:00Z",
      })),
    },
  });
  await createAdoptionGuard(root)();
  expect(
    await readFile(
      join(result.backupPath, "runtime", "rigd-state.json"),
      "utf8",
    ),
  ).toBe(raw);
  expect(await readFile(path, "utf8")).toBe(raw);
  expect(
    JSON.parse(await readFile(result.statePath, "utf8")).targets[0].plan
      .workspacePath,
  ).toBe(join(root, "workspaces", "app", "live"));
  expect(JSON.parse(await readFile(result.adoptionPath, "utf8")).status).toBe(
    "completed",
  );
  const before = await readFile(result.statePath, "utf8");
  await expect(migrateLegacyState(root)).rejects.toThrow("already exists");
  expect(await readFile(result.statePath, "utf8")).toBe(before);
});

test("missing deployed ref is an explicit preview blocker and never creates empty new state", async () => {
  const root = await fixture(),
    state = legacy(root);
  delete (state.desiredDeployments[0]!.record as { sourceCommit?: string })
    .sourceCommit;
  await writeFile(
    join(root, "runtime", "rigd-state.json"),
    JSON.stringify(state),
  );
  const preview = await readLegacyState(root);
  expect(preview.issues).toContainEqual({
    code: "missing_deployed_ref",
    message:
      "The recorded materialized Target lacks its deployed Branch or Commit; current config cannot recover it.",
    project: "app",
    target: "live",
  });
  expect(preview.state).toBeUndefined();
  await expect(migrateLegacyState(root)).rejects.toThrow("reconciliation");
  await expect(readFile(join(root, "runtime", "state.json"))).rejects.toThrow();
});

test("structurally corrupt legacy JSON fails closed and conflicting registrations remain unresolved", async () => {
  const root = await fixture(),
    path = join(root, "runtime", "rigd-state.json");
  await writeFile(path, JSON.stringify({ version: 1, events: [] }));
  await expect(readLegacyState(root)).rejects.toThrow(
    "malformed or incomplete",
  );
  const state = legacy(root);
  await writeFile(path, JSON.stringify(state));
  await writeFile(
    join(root, "registry.json"),
    JSON.stringify({
      app: {
        repoPath: join(root, "other"),
        registeredAt: "2026-01-01T00:00:00Z",
      },
    }),
  );
  expect(
    (await readLegacyState(root)).issues.some(
      (issue) => issue.code === "registration_conflict",
    ),
  ).toBe(true);
  await expect(migrateLegacyState(root)).rejects.toThrow("reconciliation");
});

test("migration refuses while a legacy writer holds its lock and concurrent migrations publish once", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "runtime", "rigd-state.json"),
    JSON.stringify(legacy(root)),
  );
  await mkdir(join(root, "runtime", "rigd-state.lock"));
  await expect(migrateLegacyState(root)).rejects.toThrow("being changed");
  await rm(join(root, "runtime", "rigd-state.lock"), { recursive: true });
  const results = await Promise.allSettled([
    migrateLegacyState(root),
    migrateLegacyState(root),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    JSON.parse(await readFile(join(root, "runtime", "state.json"), "utf8"))
      .targets,
  ).toHaveLength(1);
});

test("preview retains process adoption work even when deployed Commit metadata blocks publication", async () => {
  const root = await fixture(),
    state = legacy(root);
  delete (state.desiredDeployments[0]!.record as { sourceCommit?: string })
    .sourceCommit;
  await writeFile(
    join(root, "runtime", "rigd-state.json"),
    JSON.stringify(state),
  );
  const preview = await readLegacyState(root);
  expect(preview.state).toBeUndefined();
  expect(preview.adoption.processes[0]!.legacyLabel).toBe(
    "com.b-relay.rig.app.live.web",
  );
});

test("conflicting recorded provider selections are rejected instead of silently choosing one", async () => {
  const root = await fixture(),
    state = legacy(root);
  state.desiredDeployments[0]!.record.resolved.providers = {
    processSupervisor: "rigd",
  };
  await writeFile(
    join(root, "runtime", "rigd-state.json"),
    JSON.stringify(state),
  );
  const preview = await readLegacyState(root);
  expect(preview.state).toBeUndefined();
  expect(
    preview.issues.some((issue) => issue.code === "invalid_recorded_plan"),
  ).toBe(true);
});

test("migration preview reports missing repositories, ambiguous current config, and mismatched identities", async () => {
  const root = await fixture(),
    path = join(root, "runtime", "rigd-state.json");
  await writeFile(path, JSON.stringify(legacy(root)));
  await writeFile(
    join(root, "developer", "rig.yaml"),
    "name: app\ncomponents: {}\n",
  );
  expect(
    (await readLegacyState(root)).issues.some(
      (issue) => issue.code === "ambiguous_current_config",
    ),
  ).toBe(true);
  await rm(join(root, "developer", "rig.yaml"));
  await writeFile(
    join(root, "developer", "rig.json"),
    JSON.stringify({ name: "wrong", components: {} }),
  );
  expect(
    (await readLegacyState(root)).issues.some(
      (issue) => issue.code === "current_identity_mismatch",
    ),
  ).toBe(true);
  await rm(join(root, "developer"), { recursive: true });
  expect(
    (await readLegacyState(root)).warnings.some(
      (issue) => issue.code === "missing_repository",
    ),
  ).toBe(true);
  expect(
    (await migrateLegacyState(root)).preview.warnings.length,
  ).toBeGreaterThan(0);
});

test("explicit recovered source metadata requires matching completed legacy execution evidence and preserves provenance", async () => {
  const root = await fixture(),
    state = legacy(root);
  delete (state.desiredDeployments[0]!.record as { sourceCommit?: string })
    .sourceCommit;
  (state.events as unknown[]).push({
    timestamp: "2026-09-01T00:00:00Z",
    event: "rigd.deploy.accepted",
    project: "app",
    details: {
      target: "live",
      ref: "main",
      commit: "a".repeat(40),
      execution: {
        project: "app",
        deployment: "live",
        kind: "live",
        providerProfile: "default",
        operations: [
          `workspace-materializer:git-worktree:materialize:${state.desiredDeployments[0]!.record.workspacePath}:${"a".repeat(40)}`,
        ],
        events: [],
      },
    },
  });
  await writeFile(
    join(root, "runtime", "rigd-state.json"),
    JSON.stringify(state),
  );
  const recoveredSources = [
    {
      project: "app",
      target: "live",
      branch: "main",
      commit: "a".repeat(40),
      evidence:
        "Verified deployed source file hashes and completed legacy execution event.",
    },
  ];
  const preview = await readLegacyState(root, { recoveredSources });
  expect(preview.issues).toEqual([]);
  expect(preview.state?.targets[0]!.commit).toBe("a".repeat(40));
  expect(preview.recoveredSources).toEqual(recoveredSources);
  const wrong = await readLegacyState(root, {
    recoveredSources: [{ ...recoveredSources[0]!, commit: "b".repeat(40) }],
  });
  expect(
    wrong.issues.some((issue) => issue.code === "unverified_recovered_source"),
  ).toBe(true);
});

test("migration publication requires reviewed revision and writes recovery provenance without altering legacy records", async () => {
  const root = await fixture(),
    state = legacy(root),
    path = join(root, "runtime", "rigd-state.json");
  delete (state.desiredDeployments[0]!.record as { sourceCommit?: string })
    .sourceCommit;
  (state.events as unknown[]).push({
    timestamp: "2026-09-01T00:00:00Z",
    event: "rigd.deploy.accepted",
    project: "app",
    details: {
      target: "live",
      ref: "main",
      commit: "a".repeat(40),
      execution: {
        project: "app",
        deployment: "live",
        kind: "live",
        providerProfile: "default",
        operations: [
          `workspace-materializer:git-worktree:materialize:${state.desiredDeployments[0]!.record.workspacePath}:${"a".repeat(40)}`,
        ],
        events: [],
      },
    },
  });
  const raw = JSON.stringify(state);
  await writeFile(path, raw);
  const recoveredSources = [
    {
      project: "app",
      target: "live",
      branch: "main",
      commit: "a".repeat(40),
      evidence: "Verified tracked source hashes against surviving Git objects.",
    },
  ];
  const preview = await readLegacyState(root, { recoveredSources });
  await expect(
    publishLegacyState(root, {
      expectedRevision: "0".repeat(64),
      recoveredSources,
    }),
  ).rejects.toThrow("changed");
  const result = await publishLegacyState(root, {
    expectedRevision: preview.revision,
    recoveredSources,
  });
  expect(
    JSON.parse(await readFile(result.adoptionPath, "utf8")).recoveredSources,
  ).toEqual(recoveredSources);
  expect(await readFile(path, "utf8")).toBe(raw);
  expect(
    JSON.parse(await readFile(result.statePath, "utf8")).targets[0].commit,
  ).toBe("a".repeat(40));
});

test("an accepted receipt or empty execution cannot authorize recovered materialization metadata", async () => {
  const root = await fixture(),
    state = legacy(root);
  delete (state.desiredDeployments[0]!.record as { sourceCommit?: string })
    .sourceCommit;
  (state.events as unknown[]).push({
    timestamp: "2026-09-01T00:00:00Z",
    event: "rigd.deploy.accepted",
    project: "app",
    details: {
      target: "live",
      ref: "main",
      commit: "a".repeat(40),
      execution: {
        project: "app",
        deployment: "live",
        kind: "live",
        providerProfile: "default",
        operations: [],
        events: [],
      },
    },
  });
  await writeFile(
    join(root, "runtime", "rigd-state.json"),
    JSON.stringify(state),
  );
  const preview = await readLegacyState(root, {
    recoveredSources: [
      {
        project: "app",
        target: "live",
        branch: "main",
        commit: "a".repeat(40),
        evidence: "Claims without materialization evidence are insufficient.",
      },
    ],
  });
  expect(preview.state).toBeUndefined();
  expect(
    preview.issues.some(
      (issue) => issue.code === "unverified_recovered_source",
    ),
  ).toBe(true);
});

test("explicit source recovery cannot overwrite contradictory authoritative inventory metadata", async () => {
  const root = await fixture(),
    state = legacy(root),
    record = state.desiredDeployments[0]!.record;
  delete (record as { sourceCommit?: string }).sourceCommit;
  (state.events as unknown[]).push({
    timestamp: "2026-09-01T00:00:00Z",
    event: "rigd.deploy.accepted",
    project: "app",
    details: {
      target: "live",
      ref: "main",
      commit: "a".repeat(40),
      execution: {
        project: "app",
        deployment: "live",
        kind: "live",
        providerProfile: "default",
        operations: [
          `workspace-materializer:git-worktree:materialize:${record.workspacePath}:${"a".repeat(40)}`,
        ],
        events: [],
      },
    },
  });
  await mkdir(join(root, "runtime", "app"));
  await writeFile(
    join(root, "runtime", "app", "deployments.json"),
    JSON.stringify([{ ...record, sourceCommit: "b".repeat(40) }]),
  );
  await writeFile(
    join(root, "runtime", "rigd-state.json"),
    JSON.stringify(state),
  );
  const preview = await readLegacyState(root, {
    recoveredSources: [
      {
        project: "app",
        target: "live",
        branch: "main",
        commit: "a".repeat(40),
        evidence:
          "Verified source evidence must not hide conflicting inventory.",
      },
    ],
  });
  expect(preview.state).toBeUndefined();
  expect(
    preview.issues.some(
      (issue) => issue.code === "unverified_recovered_source",
    ),
  ).toBe(true);
});

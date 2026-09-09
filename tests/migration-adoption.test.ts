import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAdoptionGuard,
  readLegacyAdoption,
  finalizeLegacyAdoption,
} from "../src/migration/index";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rig-adoption-"));
  roots.push(root);
  await mkdir(join(root, "runtime"));
  return root;
}
function pending() {
  return {
    version: 1,
    status: "requires-adoption",
    sourceRevision: "a".repeat(64),
    backupPath: "/backup",
    adoption: {
      processes: [
        {
          project: "app",
          target: "live",
          component: "web",
          key: "target:web",
          provider: "launchd",
          legacyLabel: "com.b-relay.rig.app.live.web",
          status: "requires-adoption",
          reason: "Verify old job ownership.",
        },
      ],
      routes: [
        {
          project: "app",
          target: "live",
          component: "web",
          key: "target",
          legacyMarker: "# [rig:app:live:web]",
          hostname: "app.example.test",
          upstream: "127.0.0.1:3210",
          status: "requires-adoption",
        },
      ],
    },
    history: {
      events: 1,
      acceptedReceipts: 1,
      failures: 0,
      preservation: "original-files-and-exact-backups",
    },
  };
}
test("fresh roots are ready, but pending and malformed legacy ownership fail closed", async () => {
  const root = await fixture(),
    guard = createAdoptionGuard(root),
    path = join(root, "runtime", "legacy-adoption.json");
  await guard();
  await writeFile(path, JSON.stringify(pending()));
  await expect(guard()).rejects.toThrow("adoption");
  await writeFile(path, JSON.stringify({ status: "completed" }));
  await expect(guard()).rejects.toThrow("invalid");
});
test("a lost adoption manifest cannot authorize a root that retains legacy evidence", async () => {
  const root = await fixture();
  await writeFile(join(root, "runtime", "rigd-state.json"), "{}");
  await expect(createAdoptionGuard(root)()).rejects.toThrow("invalid");
});
function verified() {
  return {
    verifiedAt: "2026-09-09T12:00:01Z",
    processes: [
      {
        key: "target:web",
        provider: "launchd",
        legacyLabel: "com.b-relay.rig.app.live.web",
        outcome: "replaced" as const,
        observedAt: "2026-09-09T12:00:00Z",
        previousOwner: "unloaded" as const,
        currentKey: "target:web",
      },
    ],
    routes: [
      {
        key: "target",
        legacyMarker: "# [rig:app:live:web]",
        outcome: "adopted" as const,
        observedAt: "2026-09-09T12:00:00Z",
        currentKey: "target",
      },
    ],
  };
}
test("complete matching ownership evidence unlocks migrated metadata and preserves the exact pending manifest", async () => {
  const root = await fixture(),
    path = join(root, "runtime", "legacy-adoption.json"),
    raw = JSON.stringify(pending(), null, 2) + "\n";
  await writeFile(path, raw);
  const before = (await readLegacyAdoption(root))!;
  const result = await finalizeLegacyAdoption(root, {
    expectedRevision: before.revision,
    evidence: verified(),
  });
  expect(await readFile(result.backupPath, "utf8")).toBe(raw);
  expect((await readLegacyAdoption(root))!.manifest.status).toBe("completed");
  await createAdoptionGuard(root)();
  const completed = JSON.parse(await readFile(path, "utf8"));
  completed.adoption.processes = [];
  completed.evidence.processes = [];
  await writeFile(path, JSON.stringify(completed));
  await expect(createAdoptionGuard(root)()).rejects.toThrow("invalid");
});
test("missing owners, wrong labels, stale revision and contradictory observations do not finalize adoption", async () => {
  const root = await fixture(),
    path = join(root, "runtime", "legacy-adoption.json"),
    raw = JSON.stringify(pending());
  await writeFile(path, raw);
  const expectedRevision = (await readLegacyAdoption(root))!.revision;
  await expect(
    finalizeLegacyAdoption(root, {
      expectedRevision: "0".repeat(64),
      evidence: verified(),
    }),
  ).rejects.toThrow("changed");
  await expect(
    finalizeLegacyAdoption(root, {
      expectedRevision,
      evidence: { ...verified(), routes: [] },
    }),
  ).rejects.toThrow("invalid");
  await expect(
    finalizeLegacyAdoption(root, {
      expectedRevision,
      evidence: {
        ...verified(),
        processes: [
          { ...verified().processes[0]!, legacyLabel: "unrelated.job" },
        ],
      },
    }),
  ).rejects.toThrow("invalid");
  await expect(
    finalizeLegacyAdoption(root, {
      expectedRevision,
      evidence: {
        ...verified(),
        processes: [{ ...verified().processes[0]!, previousOwner: "adopted" }],
      },
    }),
  ).rejects.toThrow("invalid");
  expect(await readFile(path, "utf8")).toBe(raw);
  await expect(createAdoptionGuard(root)()).rejects.toThrow("pending");
});
test("completed ownership cannot change source provenance or backup location from the original pending manifest", async () => {
  const root = await fixture(),
    path = join(root, "runtime", "legacy-adoption.json");
  await writeFile(path, JSON.stringify(pending()));
  await finalizeLegacyAdoption(root, {
    expectedRevision: (await readLegacyAdoption(root))!.revision,
    evidence: verified(),
  });
  const completed = JSON.parse(await readFile(path, "utf8"));
  completed.backupPath = "/unrelated-backup";
  await writeFile(path, JSON.stringify(completed));
  await expect(createAdoptionGuard(root)()).rejects.toThrow("invalid");
});

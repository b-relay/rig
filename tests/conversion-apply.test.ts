import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  applyConversion,
  previewConversion,
  reviewSchema,
  rollbackConversion,
  type ConversionDeps,
} from "../src/conversion/index";
import { FileStateStore } from "../src/runtime/state-store";
import {
  DEMO_LIVE,
  PLAIN_LIVE,
  legacyRoot,
  type LegacyRootOptions,
  type LegacyState,
} from "./support/legacy-root";

const roots: Awaited<ReturnType<typeof legacyRoot>>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.remove();
});
async function legacy(options?: LegacyRootOptions) {
  const root = await legacyRoot(options);
  roots.push(root);
  return root;
}
const review = reviewSchema.parse({
    hooks: { "demo/web/preStart": { as: "build" } },
  }),
  stopped: ConversionDeps = { pidAlive: () => false, now: () => "2026-09-19" };
/** Every file under the root except what a conversion is allowed to add. */
async function tree(directory: string, base = directory) {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name),
      name = relative(base, path);
    if ([".rig/backups", ".rig/conversion"].includes(name)) continue;
    if (entry.isDirectory()) Object.assign(entries, await tree(path, base));
    else if (entry.isFile())
      entries[name] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
  }
  return entries;
}
const codes = (preview: { blockers: { code: string }[] }) =>
  preview.blockers.map((blocker) => blocker.code);
const target = (state: LegacyState, id: string) =>
  state.targets.find((entry) => entry.id === id)!;

test("each kind of unsafe evidence blocks the conversion, and a blocked apply changes nothing", async () => {
  const root = await legacy({
    state(state) {
      target(state, DEMO_LIVE).recovery = { phase: "switching" };
      target(state, PLAIN_LIVE).desired = "running";
      target(state, PLAIN_LIVE).plan.dataRoot = join(
        String(target(state, DEMO_LIVE).plan.dataRoot),
        "nested",
      );
      target(state, PLAIN_LIVE).plan.workspacePath = "/nonexistent/workspace";
      target(state, PLAIN_LIVE).plan.futureField = true;
    },
  });
  await mkdir(join(root.root, "installed/owners"), { recursive: true });
  await writeFile(
    join(root.root, "installed/owners/stray.json"),
    JSON.stringify({ targetId: "gone", componentName: "demo-tool" }),
  );
  await mkdir(join(root.root, "effect-checkpoints/op-1"), { recursive: true });
  await writeFile(
    join(root.root, "effect-checkpoints/op-1/journal.json"),
    "{}",
  );
  await mkdir(join(root.root, "process-leases"), { recursive: true });
  await writeFile(
    join(root.root, "process-leases/web.json"),
    JSON.stringify({ pid: 4242 }),
  );
  await rm(join(root.plainRepo, "rig.json"));
  const before = await tree(root.base),
    alive: ConversionDeps = { ...stopped, pidAlive: (pid) => pid === 4242 };

  const preview = await previewConversion(root.root, review, alive);
  expect(new Set(codes(preview))).toEqual(
    new Set([
      "unresolved_recovery",
      "target_running",
      "data_root_overlap",
      "missing_evidence",
      "unsupported_mapping",
      "ambiguous_ownership",
      "unresolved_effects",
      "live_process",
      "project_config",
    ]),
  );
  // A Target that never stored anything has no data directory; Rig creates it on start.
  expect(preview.warnings.join("\n")).toContain("has no data directory yet");
  const applied = applyConversion(
    root.root,
    { review, expectedRevision: preview.revision },
    alive,
  );
  await expect(applied).rejects.toMatchObject({ code: "CONVERSION_BLOCKED" });
  await applied.catch(() => {});
  expect(await tree(root.base)).toEqual(before);
});

test("apply converts only the revision that was reviewed", async () => {
  const root = await legacy(),
    preview = await previewConversion(root.root, review, stopped),
    before = await tree(root.base);
  // The same root under another review is another conversion.
  const other = reviewSchema.parse({
    hooks: { "demo/web/preStart": { as: "replaced", by: "a build in CI" } },
  });
  await expect(
    applyConversion(
      root.root,
      { review: other, expectedRevision: preview.revision },
      stopped,
    ),
  ).rejects.toMatchObject({ code: "CONVERSION_CHANGED" });
  // So is a Project configuration edited after the preview.
  await writeFile(
    join(root.plainRepo, "rig.json"),
    (await readFile(join(root.plainRepo, "rig.json"), "utf8")) + "\n",
  );
  const changed = await tree(root.base);
  await expect(
    applyConversion(
      root.root,
      { review, expectedRevision: preview.revision },
      stopped,
    ),
  ).rejects.toMatchObject({ code: "CONVERSION_CHANGED" });
  await expect(
    applyConversion(root.root, { review, expectedRevision: "latest" }, stopped),
  ).rejects.toMatchObject({ code: "CONVERSION_REVISION" });
  expect(await tree(root.base)).toEqual(changed);
  expect(Object.keys(changed)).toEqual(Object.keys(before));
});

test("a conversion is repeatable: applying twice, or again after a rollback, gives the same state", async () => {
  const root = await legacy(),
    original = await tree(root.base),
    preview = await previewConversion(root.root, review, stopped),
    options = { review, expectedRevision: preview.revision };
  const first = await applyConversion(root.root, options, stopped);
  expect(first.status).toBe("converted");
  const converted = await readFile(root.statePath, "utf8"),
    state = await new FileStateStore(root.root).read();
  // Identity, data and log locations are exactly what the retired runtime recorded; no outcome is invented.
  const live = state.targets.find((entry) => entry.id === DEMO_LIVE)!,
    mapped = preview.targets.find((entry) => entry.id === DEMO_LIVE)!;
  expect(live.plan.dataRoot).toBe(mapped.dataRoot);
  expect(live.logRoot).toBe(mapped.logRoot);
  expect(live.plan.workspacePath).toBe(mapped.workspacePath);
  expect(live.desired).toBe("stopped");
  expect(live.preparation).toBeUndefined();
  expect(live.conversion?.needsDeploy.length).toBe(3);
  expect(JSON.stringify(live.plan)).not.toContain("hooks");

  expect(await applyConversion(root.root, options, stopped)).toMatchObject({
    status: "unchanged",
  });
  expect(await readFile(root.statePath, "utf8")).toBe(converted);

  await rollbackConversion(root.root, first.backupPath!, stopped);
  expect(await tree(root.base)).toEqual(original);
  expect((await previewConversion(root.root, review, stopped)).revision).toBe(
    preview.revision,
  );
  await applyConversion(root.root, options, stopped);
  expect(await readFile(root.statePath, "utf8")).toBe(converted);
});

test("an interrupted apply leaves a root the new runtime still refuses, names its backup, and can be rolled back or finished", async () => {
  const root = await legacy(),
    original = await tree(root.base),
    preview = await previewConversion(root.root, review, stopped),
    options = { review, expectedRevision: preview.revision };
  const interrupted = applyConversion(root.root, options, {
    ...stopped,
    checkpoint(step) {
      if (step === "publish") throw new Error("power loss");
    },
  });
  await expect(interrupted).rejects.toThrow("power loss");

  // Backup and report exist, the state did not move: nothing can be activated.
  await expect(new FileStateStore(root.root).read()).rejects.toMatchObject({
    code: "STATE_UNCONVERTED",
  });
  const after = await previewConversion(root.root, review, stopped);
  expect(after.revision).toBe(preview.revision);
  expect(after.interrupted).toMatchObject({ revision: preview.revision });
  const { backupPath } = after.interrupted as { backupPath: string };

  // Either put everything back...
  expect(await rollbackConversion(root.root, backupPath, stopped)).toEqual({
    restored: ["runtime/state.json"],
  });
  expect(await tree(root.base)).toEqual(original);
  // ...or finish it: the same reviewed revision still applies.
  expect((await applyConversion(root.root, options, stopped)).status).toBe(
    "converted",
  );
  expect(Object.keys(await tree(root.base))).not.toContain(
    ".rig/runtime/conversion-pending.json",
  );
  expect((await new FileStateStore(root.root).read()).version).toBe(4);
});

test("a Host config.json blocks with a candidate config.yaml; the conversion never writes a config", async () => {
  const root = await legacy();
  await writeFile(
    join(root.root, "config.json"),
    JSON.stringify({ deploy: { productionBranch: "trunk" } }),
  );
  const before = await tree(root.base),
    preview = await previewConversion(root.root, review, stopped);
  expect(codes(preview)).toEqual(["host_config"]);
  expect(preview.host).toEqual({
    from: join(root.root, "config.json"),
    to: join(root.root, "config.yaml"),
    candidate: "deploy:\n  productionBranch: trunk\n",
  });
  expect(await tree(root.base)).toEqual(before);
  // Done by hand, as the message says, the blocker is gone.
  await writeFile(join(root.root, "config.yaml"), preview.host!.candidate!);
  await rm(join(root.root, "config.json"));
  expect(codes(await previewConversion(root.root, review, stopped))).toEqual(
    [],
  );
});

test("a daemon that appears while apply is copying stops it before the state is published", async () => {
  const root = await legacy(),
    preview = await previewConversion(root.root, review, stopped);
  let revived = false;
  const applied = applyConversion(
    root.root,
    { review, expectedRevision: preview.revision },
    {
      ...stopped,
      pidAlive: () => revived,
      async checkpoint(step) {
        if (step !== "backup") return;
        await mkdir(join(root.root, "daemon"), { recursive: true });
        await writeFile(
          join(root.root, "daemon/owner.json"),
          JSON.stringify({ pid: 77 }),
        );
        revived = true;
      },
    },
  );
  await expect(applied).rejects.toMatchObject({
    code: "CONVERSION_BLOCKED",
    details: { blockers: [{ code: "daemon_running" }] },
  });
  await expect(new FileStateStore(root.root).read()).rejects.toMatchObject({
    code: "STATE_UNCONVERTED",
  });
});

test("rollback refuses the backup of another root", async () => {
  const [one, other] = [await legacy(), await legacy()],
    options = async (root: string) => ({
      review,
      expectedRevision: (await previewConversion(root, review, stopped))
        .revision,
    });
  const applied = await applyConversion(
    one.root,
    await options(one.root),
    stopped,
  );
  await applyConversion(other.root, await options(other.root), stopped);
  const converted = await tree(other.base);
  await expect(
    rollbackConversion(other.root, applied.backupPath!, stopped),
  ).rejects.toMatchObject({
    code: "CONVERSION_BACKUP",
    details: { root: other.root, backupRoot: one.root },
  });
  expect(await tree(other.base)).toEqual(converted);
});

test("rollback refuses a live root and a backup that does not match its manifest", async () => {
  const root = await legacy(),
    preview = await previewConversion(root.root, review, stopped),
    applied = await applyConversion(
      root.root,
      { review, expectedRevision: preview.revision },
      stopped,
    );
  const converted = await tree(root.base);
  await mkdir(join(root.root, "daemon"), { recursive: true });
  await writeFile(
    join(root.root, "daemon/owner.json"),
    JSON.stringify({ pid: 77 }),
  );
  await expect(
    rollbackConversion(root.root, applied.backupPath!, {
      ...stopped,
      pidAlive: () => true,
    }),
  ).rejects.toMatchObject({ code: "CONVERSION_BLOCKED" });
  await rm(join(root.root, "daemon"), { recursive: true });

  await writeFile(join(applied.backupPath!, "runtime/state.json"), "{}");
  await expect(
    rollbackConversion(root.root, applied.backupPath!, stopped),
  ).rejects.toMatchObject({ code: "CONVERSION_BACKUP" });
  await expect(
    rollbackConversion(root.root, join(root.base, "elsewhere"), stopped),
  ).rejects.toMatchObject({ code: "CONVERSION_BACKUP" });
  expect(await tree(root.base)).toEqual(converted);
});

test("no value of an env file reaches the preview, the report or the backup", async () => {
  const root = await legacy(),
    preview = await previewConversion(root.root, review, stopped),
    applied = await applyConversion(
      root.root,
      { review, expectedRevision: preview.revision },
      stopped,
    );
  expect(JSON.stringify(preview)).not.toContain("file-secret");
  for (const directory of [applied.backupPath!, applied.reportPath!])
    for (const name of await readdir(directory, { recursive: true })) {
      const contents = await readFile(join(directory, name), "utf8").catch(
        () => "",
      );
      expect(contents).not.toContain("file-secret");
    }
  // The backup manifest lists every copied file with its digest, and the data locations it deliberately left alone.
  const manifest = JSON.parse(
    await readFile(join(applied.backupPath!, "manifest.json"), "utf8"),
  );
  expect(
    manifest.files.map((file: { relativePath: string }) => file.relativePath),
  ).toContain("runtime/state.json");
  expect(manifest.dataPaths).toHaveLength(3);
  expect(manifest.changes).toEqual([
    { relativePath: "runtime/state.json", action: "replace" },
  ]);
});

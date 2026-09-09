import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEffectTransactions } from "../src/adapters/effect-transactions";
import { createArtifactOwnership } from "../src/adapters/artifact-ownership";
import { createCaddyRouter } from "../src/providers/caddy-router";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "rig-preparation-")),
  );
  roots.push(root);
  const directory = join(
    root,
    "effect-checkpoints",
    createHash("sha256").update("target").digest("hex"),
  );
  const router = createCaddyRouter({
    caddyfile: join(root, "Caddyfile"),
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  const transactions = () =>
    createEffectTransactions({
      root,
      ownership: createArtifactOwnership(root),
      router,
    });
  const claim = directory + ".preparing.json";
  return { root, directory, claim, router, transactions };
}
test("recovery clears proven incomplete preparation and permits retry without touching active effects", async () => {
  const f = await fixture();
  await mkdir(f.directory, { recursive: true });
  await writeFile(
    f.claim,
    JSON.stringify({ version: 1, targetId: "target", directory: f.directory }),
  );
  await writeFile(join(f.directory, "0.backup"), "partial");
  await mkdir(join(f.root, "bin"));
  await writeFile(join(f.root, "bin", "active"), "usable");
  await f.router.apply({
    key: "target",
    hostname: "active.test",
    upstream: "localhost:1234",
  });
  const route = await f.router.checkpoint("target");
  await f.transactions().restore("target");
  const checkpoint = await f.transactions().checkpoint("target", []);
  await checkpoint.commit();
  expect(await readFile(join(f.root, "bin", "active"), "utf8")).toBe("usable");
  expect(await f.router.checkpoint("target")).toEqual(route);
  await expect(readFile(f.claim)).rejects.toMatchObject({ code: "ENOENT" });
});
test("legacy backup-only orphan is preserved with its location reported, and retry succeeds", async () => {
  const f = await fixture();
  await mkdir(f.directory, { recursive: true });
  await writeFile(join(f.directory, "0.backup"), "legacy partial bytes");
  let archivePath = "";
  try {
    await f.transactions().restore("target");
  } catch (error) {
    expect(error).toMatchObject({
      code: "EFFECTS_PREPARATION_PRESERVED",
      details: { targetId: "target" },
    });
    archivePath = (error as { details: { archivePath: string } }).details
      .archivePath;
    expect((error as { hint: string }).hint).toContain(archivePath);
  }
  expect(archivePath).not.toBe("");
  expect(await readFile(join(archivePath, "0.backup"), "utf8")).toBe(
    "legacy partial bytes",
  );
  await f.transactions().restore("target");
  await (await f.transactions().checkpoint("target", [])).commit();
  expect(await readFile(join(archivePath, "0.backup"), "utf8")).toBe(
    "legacy partial bytes",
  );
});
test("a corrupt preparation claim cannot discard even a committed checkpoint", async () => {
  const f = await fixture();
  await f.transactions().checkpoint("target", []);
  const journalPath = join(f.directory, "journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.phase = "committed";
  await writeFile(journalPath, JSON.stringify(journal));
  await writeFile(f.claim, "corrupt claim");
  await expect(f.transactions().restore("target")).rejects.toMatchObject({
    code: "EFFECTS_CHECKPOINT",
  });
  expect(JSON.parse(await readFile(journalPath, "utf8"))).toEqual(journal);
});

for (const stage of [
  "claim-only",
  "empty-directory",
  "partial-backup",
  "journal-temporary",
  "claim-temporary",
] as const) {
  test(`recovery and retry survive preparation interruption at ${stage}`, async () => {
    const f = await fixture();
    await mkdir(join(f.root, "effect-checkpoints"));
    if (stage === "claim-temporary") {
      await writeFile(f.claim + ".incomplete.tmp", '{"version":');
    } else {
      await writeFile(
        f.claim,
        JSON.stringify({
          version: 1,
          targetId: "target",
          directory: f.directory,
        }),
      );
      if (stage !== "claim-only") await mkdir(f.directory);
      if (stage === "partial-backup")
        await writeFile(join(f.directory, "0.backup"), "part");
      if (stage === "journal-temporary")
        await writeFile(
          join(
            f.directory,
            "journal.json.00000000-0000-0000-0000-000000000000.tmp",
          ),
          '{"targetId":',
        );
    }
    await f.transactions().restore("target");
    await (await f.transactions().checkpoint("target", [])).rollback();
    await f.transactions().restore("target");
    expect(await readdir(join(f.root, "effect-checkpoints"))).toEqual(
      stage === "claim-temporary"
        ? [f.claim.split("/").at(-1)! + ".incomplete.tmp"]
        : [],
    );
  });
}
for (const evidence of [
  "unrelated",
  "nested",
  "symlink-backup",
  "symlink-directory",
  "symlink-parent",
  "corrupt-journal",
  "wrong-journal-target",
  "wrong-claim-target",
  "wrong-claim-path",
  "corrupt-claim",
] as const) {
  test(`recovery preserves ambiguous evidence: ${evidence}`, async () => {
    const f = await fixture();
    const outside = join(f.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "precious"), "keep");
    if (evidence === "symlink-parent")
      await symlink(outside, join(f.root, "effect-checkpoints"));
    else {
      await mkdir(join(f.root, "effect-checkpoints"));
      if (evidence === "symlink-directory") await symlink(outside, f.directory);
      else {
        await mkdir(f.directory);
        await writeFile(join(f.directory, "0.backup"), "partial");
        if (evidence === "unrelated")
          await writeFile(join(f.directory, "notes"), "keep");
        if (evidence === "nested") await mkdir(join(f.directory, "1.backup"));
        if (evidence === "symlink-backup")
          await symlink(
            join(outside, "precious"),
            join(f.directory, "1.backup"),
          );
        if (evidence === "corrupt-journal")
          await writeFile(join(f.directory, "journal.json"), "broken");
        if (evidence === "wrong-journal-target")
          await writeFile(
            join(f.directory, "journal.json"),
            JSON.stringify({
              targetId: "other",
              phase: "committed",
              files: [],
              route: {
                before: { key: "other", value: null },
                expected: { key: "other", value: null },
              },
            }),
          );
        if (evidence.startsWith("wrong-claim"))
          await writeFile(
            f.claim,
            JSON.stringify({
              version: 1,
              targetId: evidence === "wrong-claim-target" ? "other" : "target",
              directory:
                evidence === "wrong-claim-path" ? outside : f.directory,
            }),
          );
        if (evidence === "corrupt-claim") await writeFile(f.claim, "broken");
      }
    }
    const before = await readdir(join(f.root, "effect-checkpoints"));
    await expect(f.transactions().restore("target")).rejects.toMatchObject({
      code: "EFFECTS_CHECKPOINT",
    });
    await expect(f.transactions().checkpoint("target", [])).rejects.toThrow();
    expect(await readdir(join(f.root, "effect-checkpoints"))).toEqual(before);
    expect(await readFile(join(outside, "precious"), "utf8")).toBe("keep");
    if (!evidence.startsWith("symlink-"))
      expect(await readFile(join(f.directory, "0.backup"), "utf8")).toBe(
        "partial",
      );
  });
}
test("valid pending journal remains rollback authority and committed journal permits retry", async () => {
  const f = await fixture();
  await f.transactions().checkpoint("target", []);
  const bytes = await readFile(join(f.directory, "journal.json"), "utf8");
  await expect(f.transactions().checkpoint("target", [])).rejects.toMatchObject(
    { code: "EFFECTS_RECOVERY" },
  );
  expect(await readFile(join(f.directory, "journal.json"), "utf8")).toBe(bytes);
  await f.transactions().restore("target");
  await f.transactions().checkpoint("target", []);
  const committed = JSON.parse(bytes);
  committed.phase = "committed";
  await writeFile(join(f.directory, "journal.json"), JSON.stringify(committed));
  await (await f.transactions().checkpoint("target", [])).commit();
});
test("unrelated files beside a valid committed journal remain protected", async () => {
  const f = await fixture();
  await f.transactions().checkpoint("target", []);
  const path = join(f.directory, "journal.json");
  const journal = JSON.parse(await readFile(path, "utf8"));
  journal.phase = "committed";
  await writeFile(path, JSON.stringify(journal));
  await writeFile(join(f.directory, "precious"), "keep");
  await expect(f.transactions().restore("target")).rejects.toMatchObject({
    code: "EFFECTS_CHECKPOINT",
  });
  expect(await readFile(join(f.directory, "precious"), "utf8")).toBe("keep");
});

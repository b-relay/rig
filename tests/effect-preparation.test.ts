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
import type { RouteCheckpoint } from "../src/providers/caddy-router";
import type { PrunedCheckpoint } from "../src/runtime/lifecycle";
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
test("a journal carrying keys this rigd does not know is still rolled back, and the keys survive its rewrite", async () => {
  const f = await fixture();
  await f.transactions().checkpoint("target", []);
  const path = join(f.directory, "journal.json");
  const journal = JSON.parse(await readFile(path, "utf8"));
  journal.future = { added: "by a newer rigd" };
  journal.route.future = true;
  await writeFile(path, JSON.stringify(journal));
  let failures = 1;
  const router = {
    ...f.router,
    async restore(saved: RouteCheckpoint, expected: RouteCheckpoint) {
      if (failures-- > 0) throw new Error("caddy is not answering");
      return f.router.restore(saved, expected);
    },
  };
  const transactions = createEffectTransactions({
    root: f.root,
    ownership: createArtifactOwnership(f.root),
    router,
  });
  await expect(transactions.restore("target")).rejects.toThrow(
    "caddy is not answering",
  );
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    version: 1,
    future: { added: "by a newer rigd" },
    route: { future: true },
  });
  await transactions.restore("target");
  expect(await readdir(join(f.root, "effect-checkpoints"))).toEqual([]);
});
test.each([
  {
    shape: "a newer format version",
    edit: (journal: Record<string, unknown>) => ({ ...journal, version: 2 }),
    hint: [/version 2/, /version 1/],
    details: { version: 2 },
  },
  {
    shape: "an invalid field",
    edit: (journal: Record<string, unknown>) => ({
      ...journal,
      phase: "later",
    }),
    hint: [/journal\.json/, /at phase:/],
    details: { issues: [{ path: ["phase"] }] },
  },
])(
  "a journal with $shape is refused with the file and the problem named, and nothing is changed",
  async ({ edit, hint, details }) => {
    const f = await fixture();
    await f.transactions().checkpoint("target", []);
    const path = join(f.directory, "journal.json");
    const bytes = JSON.stringify(
      edit(JSON.parse(await readFile(path, "utf8"))),
    );
    await writeFile(path, bytes);
    for (const operation of ["restore", "commit", "checkpoint"] as const) {
      const error = await f
        .transactions()
        [operation]("target", [])
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(error).toMatchObject({
        code: "EFFECTS_CHECKPOINT",
        details: { path, ...details },
      });
      for (const pattern of hint)
        expect((error as { hint: string }).hint).toMatch(pattern);
    }
    expect(await readFile(path, "utf8")).toBe(bytes);
  },
);
test("pruning removes checkpoints and claims of Targets absent from state, keeps live ones, and retains a pending journal that recorded a change", async () => {
  const f = await fixture();
  const hash = (targetId: string) =>
    createHash("sha256").update(targetId).digest("hex");
  const checkpoints = join(f.root, "effect-checkpoints");
  await f.transactions().checkpoint("target", []);
  await f.transactions().checkpoint("gone", []);
  const gone = JSON.parse(
    await readFile(join(checkpoints, hash("gone"), "journal.json"), "utf8"),
  );
  gone.phase = "committed";
  await writeFile(
    join(checkpoints, hash("gone"), "journal.json"),
    JSON.stringify(gone),
  );
  await writeFile(
    join(checkpoints, `${hash("stale")}.preparing.json`),
    JSON.stringify({
      version: 1,
      targetId: "stale",
      directory: join(checkpoints, hash("stale")),
    }),
  );
  await f.transactions().checkpoint("changed", []);
  const changed = JSON.parse(
    await readFile(join(checkpoints, hash("changed"), "journal.json"), "utf8"),
  );
  changed.route.expected = { key: "changed", value: "written" };
  await writeFile(
    join(checkpoints, hash("changed"), "journal.json"),
    JSON.stringify(changed),
  );
  await mkdir(join(checkpoints, hash("garbled")));
  await writeFile(join(checkpoints, hash("garbled"), "journal.json"), "{nope");
  const pruned = await f.transactions().pruneCheckpoints(new Set(["target"]));
  const expected: PrunedCheckpoint[] = [
    {
      path: join(checkpoints, hash("gone")),
      targetId: "gone",
      outcome: "removed",
    },
    {
      path: join(checkpoints, `${hash("stale")}.preparing.json`),
      targetId: "stale",
      outcome: "removed",
    },
    {
      path: join(checkpoints, hash("changed")),
      targetId: "changed",
      outcome: "retained",
      reason: expect.stringMatching(/rollback/),
    },
    {
      path: join(checkpoints, hash("garbled")),
      outcome: "retained",
      reason: expect.stringMatching(
        /could not be read: .*journal\.json is not valid JSON/,
      ),
    },
  ];
  const byPath = (a: PrunedCheckpoint, b: PrunedCheckpoint) =>
    a.path.localeCompare(b.path);
  expect(pruned.sort(byPath)).toEqual(expected.sort(byPath));
  expect((await readdir(checkpoints)).sort()).toEqual(
    [
      hash("target"),
      `${hash("target")}.preparing.json`,
      hash("changed"),
      `${hash("changed")}.preparing.json`,
      hash("garbled"),
    ].sort(),
  );
  await f.transactions().restore("target");
  expect(await f.transactions().pruneCheckpoints(new Set())).toHaveLength(2);
});

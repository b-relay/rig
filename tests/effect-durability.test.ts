import { afterEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Every file flush, rename, copy, directory creation and removal, in the order it completed. */
const trace: string[] = [];
const real = { ...fs };
mock.module("node:fs/promises", () => ({
  ...real,
  async open(path: string, ...rest: unknown[]) {
    const handle = await (
      real.open as (...args: unknown[]) => Promise<fs.FileHandle>
    )(path, ...rest);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      await sync();
      trace.push(`sync ${path}`);
    };
    return handle;
  },
  async rename(from: string, to: string) {
    await real.rename(from, to);
    trace.push(`rename ${to}`);
  },
  async copyFile(from: string, to: string, mode?: number) {
    await real.copyFile(from, to, mode);
    trace.push(`copy ${to}`);
  },
  async mkdir(path: string, options?: unknown) {
    const made = await (real.mkdir as (...args: unknown[]) => unknown)(
      path,
      options,
    );
    trace.push(`mkdir ${path}`);
    return made;
  },
  async rm(path: string, options?: unknown) {
    await (real.rm as (...args: unknown[]) => Promise<void>)(path, options);
    trace.push(`rm ${path}`);
  },
}));
const { createEffectTransactions } =
  await import("../src/adapters/effect-transactions");
const { createArtifactOwnership } =
  await import("../src/adapters/artifact-ownership");
const { unreloadedCaddy } = await import("./support/router-doubles");

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await real.rm(root, { recursive: true, force: true });
});

/** A Rig root with a Tool its Target published, and that Target's effect transactions. */
async function fixture() {
  const root = await real.realpath(
    await real.mkdtemp(join(tmpdir(), "rig-durability-")),
  );
  roots.push(root);
  const ownership = createArtifactOwnership(root);
  const tool = {
    targetId: "target",
    componentName: "tool",
    destination: join(root, "bin", "tool"),
    receiptPath: join(root, "installed", "tool.json"),
  };
  await real.mkdir(join(root, "bin"), { recursive: true });
  await real.mkdir(join(root, "installed"), { recursive: true });
  await ownership.publish(tool, () =>
    real.writeFile(tool.destination, "#!/bin/sh\necho old\n", { mode: 0o755 }),
  );
  await real.writeFile(tool.receiptPath, "{}", { mode: 0o600 });
  const directory = join(
    root,
    "effect-checkpoints",
    createHash("sha256").update("target").digest("hex"),
  );
  const transactions = createEffectTransactions({
    root,
    ownership,
    router: unreloadedCaddy(root),
  });
  return { root, tool, directory, transactions };
}

/** Where the first trace entry `matches` is; fails the test when there is none. */
function at(matches: (entry: string) => boolean, from = 0): number {
  const index = trace.findIndex(
    (entry, position) => position >= from && matches(entry),
  );
  if (index === -1)
    throw new Error(`no such step after ${from} in:\n${trace.join("\n")}`);
  return index;
}
const is = (entry: string) => (seen: string) => seen === entry;
/** A file written whole through a temporary file beside `path`, flushed before it is renamed over `path`. */
const temporaryOf = (path: string) => (seen: string) =>
  seen.startsWith(`sync ${path}.`) && seen.endsWith(".tmp");

test("an effect checkpoint is on disk, its claim, directory, backups and journal, before the change it records; a commit is on disk before the checkpoint goes", async () => {
  const f = await fixture();
  const claim = `${f.directory}.preparing.json`;
  const journal = join(f.directory, "journal.json");
  trace.length = 0;
  const checkpoint = await f.transactions.checkpoint("target", [f.tool]);

  // The claim is flushed, renamed into place and its directory flushed before the checkpoint directory exists, and that
  // directory's creation is flushed before anything is written into it.
  const claimed = at(is(`rename ${claim}`));
  expect(at(temporaryOf(claim))).toBeLessThan(claimed);
  const made = at(is(`mkdir ${f.directory}`));
  expect(at(is(`sync ${dirname(claim)}`), claimed)).toBeLessThan(made);
  const firstCopy = at((seen) => seen.startsWith("copy "));
  expect(at(is(`sync ${dirname(f.directory)}`), made)).toBeLessThan(firstCopy);
  // Each backup's bytes are flushed before the journal that names it is published, and the journal is flushed before its
  // rename and its directory after.
  const published = at(is(`rename ${journal}`));
  const backups = trace.filter((seen) => seen.startsWith("copy "));
  expect(backups.length).toBe(3);
  for (const copy of backups)
    expect(at(is(`sync ${copy.slice("copy ".length)}`))).toBeLessThan(
      published,
    );
  expect(at(temporaryOf(journal))).toBeLessThan(published);
  at(is(`sync ${f.directory}`), published);

  // A change is recorded as begun, on disk, before it is made.
  trace.length = 0;
  await f.transactions.withArtifactChange(
    "target",
    [f.tool.destination],
    async () => {
      trace.push("change");
    },
  );
  const begun = at(is(`rename ${journal}`));
  expect(at(is(`sync ${f.directory}`), begun)).toBeLessThan(at(is("change")));

  // The committed journal is on disk before the checkpoint directory is removed.
  trace.length = 0;
  await checkpoint.commit();
  const committed = at(is(`rename ${journal}`));
  expect(at(is(`sync ${f.directory}`), committed)).toBeLessThan(
    at(is(`rm ${f.directory}`)),
  );
});

test("a rollback puts each file back on disk before its journal records it restored", async () => {
  const f = await fixture();
  const journal = join(f.directory, "journal.json");
  const checkpoint = await f.transactions.checkpoint("target", [f.tool]);
  await f.transactions.withArtifactChange(
    "target",
    [f.tool.destination],
    async () => {
      await real.writeFile(f.tool.destination, "#!/bin/sh\necho new\n");
    },
  );
  trace.length = 0;
  await checkpoint.rollback();
  expect(await real.readFile(f.tool.destination, "utf8")).toBe(
    "#!/bin/sh\necho old\n",
  );
  const restored = at(is(`rename ${f.tool.destination}`));
  expect(at(temporaryOf(f.tool.destination))).toBeLessThan(restored);
  expect(at(is(`sync ${dirname(f.tool.destination)}`), restored)).toBeLessThan(
    at(is(`rename ${journal}`), restored),
  );
});

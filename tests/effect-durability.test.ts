import { afterEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TargetRecord } from "../src/domain/runtime";

/** Every file flush, rename, copy, directory creation and removal, in the order it completed. */
const trace: string[] = [];
/** While set, flushing this path fails as a disk would. */
let failingFlush: string | undefined;
const real = { ...fs };
mock.module("node:fs/promises", () => ({
  ...real,
  async open(path: string, ...rest: unknown[]) {
    const handle = await (
      real.open as (...args: unknown[]) => Promise<fs.FileHandle>
    )(path, ...rest);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      if (path === failingFlush)
        throw Object.assign(new Error("flush failed"), { code: "EIO" });
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
const { createTargetEffects } = await import("../src/adapters/target-effects");
const { createArtifactInstaller } =
  await import("../src/providers/artifact-installer");
const { createChildSupervisor } =
  await import("../src/providers/child-supervisor");
const { createProcessInspection, platformKill } =
  await import("../src/providers/process-inspection");
const { createProcessTiming } = await import("../src/providers/process-timing");
const { runCommand } = await import("../src/providers/command-runner");
const { unreloadedCaddy, noRoutes } = await import("./support/router-doubles");
const { localActivation } = await import("./support/activation-doubles");

const roots: string[] = [];
afterEach(async () => {
  failingFlush = undefined;
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

test("a rollback removes a file its change created, the removal flushed, before its journal records it restored; a flush that fails keeps the checkpoint for the retry", async () => {
  const f = await fixture();
  const journal = join(f.directory, "journal.json");
  const fresh = {
    ...f.tool,
    componentName: "fresh",
    destination: join(f.root, "bin", "fresh"),
    receiptPath: join(f.root, "installed", "fresh.json"),
  };
  const checkpoint = await f.transactions.checkpoint("target", [fresh]);
  await f.transactions.withArtifactChange(
    "target",
    [fresh.destination],
    async () => {
      await real.writeFile(fresh.destination, "#!/bin/sh\necho new\n", {
        mode: 0o755,
      });
    },
  );
  failingFlush = join(f.root, "bin");
  await expect(checkpoint.rollback()).rejects.toMatchObject({
    code: "FILE_NOT_DURABLE",
  });
  // Never recorded as restored, and the checkpoint stays for the next recovery, which takes the removal for its own.
  expect(JSON.parse(await real.readFile(journal, "utf8"))).toMatchObject({
    phase: "pending",
    files: expect.arrayContaining([
      expect.objectContaining({ path: fresh.destination, applying: true }),
    ]),
  });
  failingFlush = undefined;
  trace.length = 0;
  await f.transactions.restore("target");
  const removed = at(is(`rm ${fresh.destination}`));
  expect(at(is(`sync ${join(f.root, "bin")}`), removed)).toBeLessThan(
    at(is(`rename ${journal}`), removed),
  );
  await expect(real.stat(fresh.destination)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(real.stat(f.directory)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

/** A working Target of `root` with one Tool, `cli`, in its workspace, and a way to make its Target effects afresh, as a
 * new daemon does. */
async function toolTarget(root: string) {
  const workspace = join(root, "workspace");
  await real.mkdir(workspace);
  await real.writeFile(join(workspace, "cli"), "#!/bin/sh\necho cli\n", {
    mode: 0o755,
  });
  const effects = () =>
    createTargetEffects({
      ...localActivation(),
      root,
      recordingTime: () => new Date().toISOString(),
      supervisors: new Map(),
      run: runCommand,
      installer: createArtifactInstaller({
        run: runCommand,
        bunExecutable: undefined,
      }),
      router: noRoutes(),
      environment: { PATH: process.env.PATH! },
    });
  const component = {
    name: "cli",
    kind: "installed" as const,
    entrypoint: "cli",
    env: {},
    dependsOn: [],
  };
  const record: TargetRecord = {
    id: "retiring",
    projectId: "p",
    name: "working",
    kind: "working" as const,
    desired: "stopped" as const,
    createdAt: "now",
    updatedAt: "now",
    logRoot: join(root, "logs"),
    plan: {
      project: "demo",
      target: "working",
      workspacePath: workspace,
      dataRoot: workspace,
      deploymentName: "working",
      branchSlug: "working",
      subdomain: "working",
      providers: { processSupervisor: "child" },
      components: [component],
      preparedComponents: [],
    },
  };
  return { effects, component, record };
}

test("retiring a Tool flushes each removal before the journal captures it", async () => {
  const f = await fixture();
  const { effects: fresh, component, record } = await toolTarget(f.root);
  const effects = fresh();
  await effects.install(component, record);
  const checkpoint = await effects.checkpoint(record);
  trace.length = 0;
  await effects.retireArtifacts(record);
  const journal = join(
    f.root,
    "effect-checkpoints",
    createHash("sha256").update("retiring").digest("hex"),
    "journal.json",
  );
  const removals = trace.filter(
    (seen) => seen.startsWith("rm ") && !seen.includes("effect-checkpoints"),
  );
  // The executable, its ownership record and its receipt.
  expect(removals.length).toBe(3);
  const captured = trace.lastIndexOf(`rename ${journal}`);
  for (const removal of removals) {
    const path = removal.slice("rm ".length);
    expect(at(is(`sync ${dirname(path)}`), at(is(removal)))).toBeLessThan(
      captured,
    );
  }
  await checkpoint.commit();
});

test("a durable record in a fresh root flushes every directory from the root down to it, the new ones included", async () => {
  const root = await real.realpath(
    await real.mkdtemp(join(tmpdir(), "rig-durability-fresh-")),
  );
  roots.push(root);
  const directories = (record: string) => {
    const chain: string[] = [];
    for (let at = dirname(record); at !== dirname(root); at = dirname(at))
      chain.push(at);
    return chain;
  };
  const flushedBefore = (record: string, end: number) => {
    const renamed = at(is(`rename ${record}`));
    for (const directory of directories(record))
      expect(at(is(`sync ${directory}`), renamed)).toBeLessThan(end);
  };

  // An ownership record two new directories deep.
  const ownership = createArtifactOwnership(root);
  const tool = {
    targetId: "target",
    componentName: "tool",
    destination: join(root, "bin", "tool"),
  };
  await real.mkdir(join(root, "bin"));
  trace.length = 0;
  await ownership.publish(tool, () =>
    real.writeFile(tool.destination, "#!/bin/sh\n", { mode: 0o755 }),
  );
  flushedBefore(ownership.ownerPath(tool.destination), trace.length);

  // A checkpoint's claim and journal, under a checkpoints directory made just now.
  trace.length = 0;
  const transactions = createEffectTransactions({
    root,
    ownership,
    router: unreloadedCaddy(root),
  });
  const checkpoint = await transactions.checkpoint("target", []);
  const directory = join(
    root,
    "effect-checkpoints",
    createHash("sha256").update("target").digest("hex"),
  );
  flushedBefore(`${directory}.preparing.json`, at(is(`mkdir ${directory}`)));
  flushedBefore(join(directory, "journal.json"), trace.length);
  await checkpoint.commit();

  // A process lease, its directory made by the first command recorded.
  const supervisor = createChildSupervisor({
    stateRoot: root,
    timing: createProcessTiming(),
    processInspection: createProcessInspection({
      run: runCommand,
      kill: platformKill,
    }),
  });
  trace.length = 0;
  let lease = "";
  await runCommand({
    command: ["/bin/sh", "-c", "exit 0"],
    env: { PATH: process.env.PATH! },
    started: async (pid) => {
      await supervisor.own!("t:preparation:run", pid);
      lease = trace
        .find((seen) => seen.startsWith("rename "))!
        .slice("rename ".length);
      flushedBefore(lease, trace.length);
    },
  });
  expect(dirname(lease)).toBe(join(root, "process-leases"));
  await supervisor.disown!("t:preparation:run");
});

test("a retirement whose removal could not be flushed stays recorded as begun, and a new daemon's recovery puts the Tool back even when the removal did not last", async () => {
  const f = await fixture();
  const { effects, component, record } = await toolTarget(f.root);
  const first = effects();
  await first.install(component, record);
  const destination = join(f.root, "bin", "cli-dev");
  const published = await real.readFile(destination);
  await first.checkpoint(record);
  failingFlush = join(f.root, "bin");
  await expect(first.retireArtifacts(record)).rejects.toMatchObject({
    code: "FILE_NOT_DURABLE",
  });
  failingFlush = undefined;
  const journal = JSON.parse(
    await real.readFile(
      join(
        f.root,
        "effect-checkpoints",
        createHash("sha256").update("retiring").digest("hex"),
        "journal.json",
      ),
      "utf8",
    ),
  );
  expect(journal.files).toContainEqual(
    expect.objectContaining({ path: destination, applying: true }),
  );
  // The Host lost the unflushed removal: the executable's old directory entry survived.
  await real.writeFile(destination, published, { mode: 0o755 });
  await effects().restoreEffects(record);
  expect(await real.readFile(destination)).toEqual(published);
  await expect(
    real.stat(
      join(
        f.root,
        "effect-checkpoints",
        createHash("sha256").update("retiring").digest("hex"),
      ),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

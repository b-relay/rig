import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeState } from "../src/domain/runtime";
import { FileStateStore } from "../src/runtime/state-store";

// How FileStateStore.update writes: what it flushes and when, what each failure on the way leaves, and that its queue waits
// for an asynchronous change and goes on after a failed one. tests/state.test.ts covers what the file holds.

const roots: string[] = [];
const restores: (() => void)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

async function storeRoot() {
  const root = await fs.mkdtemp(join(tmpdir(), "rig-state-update-"));
  roots.push(root);
  const path = join(root, "runtime", "state.json");
  return {
    root,
    path,
    store: new FileStateStore(root),
    file: () => fs.readFile(path, "utf8"),
    /** What is in the runtime directory besides state.json and its backup: a temporary file left behind. */
    leftovers: async () =>
      (await fs.readdir(join(root, "runtime"))).filter(
        (name) => name !== "state.json" && name !== "state.json.bak",
      ),
  };
}

const project = (name: string) => ({
  id: name,
  name,
  repoPath: `/repos/${name}`,
  configPath: `/repos/${name}/rig.yaml`,
  createdAt: "2026-11-07T00:00:00Z",
});
const add = (name: string) => (state: RuntimeState) => {
  state.projects.push(project(name));
};
const names = (state: RuntimeState) => state.projects.map((p) => p.name);

/** The class of every open file and directory: its methods are what the store's writes call. */
async function fileHandleClass(): Promise<fs.FileHandle> {
  const handle = await fs.open(tmpdir(), "r");
  await handle.close();
  return Object.getPrototypeOf(handle) as fs.FileHandle;
}

/** Wraps `method` of `on` for the rest of the test; `replace` gets the original to call or not. */
function intercept<T extends object, K extends keyof T>(
  on: T,
  method: K,
  replace: (original: T[K]) => T[K],
): void {
  const original = on[method];
  const spy = spyOn(on, method as never).mockImplementation(
    replace(original) as never,
  );
  restores.push(() => spy.mockRestore());
}

/** Records every flush: the new file, before or after it became state.json, or a directory by name. `fail` makes the
 * flushes it picks throw: of the file, or of the directory it names. */
async function traceFlushes(
  at: Awaited<ReturnType<typeof storeRoot>>,
  marker: string,
  fail?: (flushed: "file" | "runtime" | "root") => boolean,
) {
  const directories = new Map<number, "root" | "runtime">([
    [(await fs.stat(at.root)).ino, "root"],
    [(await fs.stat(join(at.root, "runtime"))).ino, "runtime"],
  ]);
  const flushes: string[] = [];
  intercept(
    await fileHandleClass(),
    "sync",
    (original) =>
      async function (this: fs.FileHandle) {
        const info = await this.stat();
        const published = (await at.file()).includes(marker);
        flushes.push(
          info.isDirectory()
            ? `directory ${directories.get(info.ino)} ${published ? "after" : "before"} the rename`
            : `file ${published ? "after" : "before"} the rename`,
        );
        if (fail?.(info.isDirectory() ? directories.get(info.ino)! : "file"))
          throw Object.assign(new Error("injected flush failure"), {
            code: "EIO",
          });
        return original.call(this);
      },
  );
  return flushes;
}

test("an update flushes the new file before it becomes state.json, then every directory from state.json up to the root", async () => {
  const at = await storeRoot();
  await at.store.update(add("first"));
  const flushes = await traceFlushes(at, '"second"');
  await at.store.update(add("second"));
  expect(flushes).toEqual([
    "file before the rename",
    "directory runtime after the rename",
    "directory root after the rename",
  ]);
  expect(names(await new FileStateStore(at.root).read())).toEqual([
    "first",
    "second",
  ]);
});

test("a failure writing, flushing, backing up or renaming leaves state.json as it was and no temporary file, and the next update goes ahead", async () => {
  type At = Awaited<ReturnType<typeof storeRoot>>;
  const failures: Record<string, (at: At) => Promise<void>> = {
    write: async () =>
      intercept(await fileHandleClass(), "writeFile", () => async () => {
        throw new Error("injected write failure");
      }),
    flush: async (at) => {
      await traceFlushes(at, '"broken"', (kind) => kind === "file");
    },
    backup: async () =>
      intercept(fs, "link", () => async () => {
        throw new Error("injected backup failure");
      }),
    rename: async () =>
      intercept(fs, "rename", () => async () => {
        throw new Error("injected rename failure");
      }),
  };
  for (const [step, inject] of Object.entries(failures)) {
    const at = await storeRoot();
    await at.store.update(add("first"));
    await at.store.update(add("second"));
    const committed = await at.file();
    await inject(at);
    await expect(at.store.update(add("broken"))).rejects.toThrow(
      `injected ${step} failure`,
    );
    for (const restore of restores.splice(0)) restore();
    expect({ step, file: await at.file() }).toEqual({ step, file: committed });
    expect({ step, leftovers: await at.leftovers() }).toEqual({
      step,
      leftovers: [],
    });
    await at.store.update(add("after"));
    expect(names(await new FileStateStore(at.root).read())).toEqual([
      "first",
      "second",
      "after",
    ]);
  }
});

test("either directory that cannot be flushed, state.json's or the root, fails FILE_NOT_DURABLE with the new state in place and the previous one kept", async () => {
  for (const directory of ["runtime", "root"] as const) {
    const at = await storeRoot();
    await at.store.update(add("first"));
    const previous = await at.file();
    await traceFlushes(at, '"second"', (flushed) => flushed === directory);
    expect({
      directory,
      failure: await at.store.update(add("second")).then(
        () => "resolved",
        (error: unknown) => error,
      ),
    }).toMatchObject({
      directory,
      failure: {
        code: "FILE_NOT_DURABLE",
        details: { path: at.path, published: true, cause: "EIO" },
      },
    });
    for (const restore of restores.splice(0)) restore();
    expect(names(await new FileStateStore(at.root).read())).toEqual([
      "first",
      "second",
    ]);
    expect(await fs.readFile(`${at.path}.bak`, "utf8")).toBe(previous);
    expect(await at.leftovers()).toEqual([]);
  }
});

test("an update waits for its asynchronous change before saving, and the update queued behind it sees that change", async () => {
  const at = await storeRoot();
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  const { promise: gate, resolve: open } = Promise.withResolvers<void>();
  const events: string[] = [];
  const first = at.store
    .update(async (state) => {
      start();
      await gate;
      add("slow")(state);
    })
    .then(() => events.push("first saved"));
  let seen: string[] = [];
  const second = at.store
    .update((state) => {
      seen = names(state);
      add("next")(state);
    })
    .then(() => events.push("second saved"));
  await started;
  expect(events).toEqual([]);
  open();
  await Promise.all([first, second]);
  expect(events).toEqual(["first saved", "second saved"]);
  expect(seen).toEqual(["slow"]);
  expect(names(await new FileStateStore(at.root).read())).toEqual([
    "slow",
    "next",
  ]);
});

test("a change that fails, at once or after waiting, saves nothing and fails only its own update; later updates go ahead", async () => {
  const at = await storeRoot();
  await at.store.update(add("first"));
  const committed = await at.file();
  const { promise: gate, resolve: open } = Promise.withResolvers<void>();
  const refused = at.store.update(() => {
    throw new Error("refused at once");
  });
  const later = at.store.update(async () => {
    await gate;
    throw new Error("refused after waiting");
  });
  const kept = at.store.update(add("kept"));
  open();
  await expect(refused).rejects.toThrow("refused at once");
  await expect(later).rejects.toThrow("refused after waiting");
  await kept;
  expect(names(await new FileStateStore(at.root).read())).toEqual([
    "first",
    "kept",
  ]);
  expect(await fs.readFile(`${at.path}.bak`, "utf8")).toBe(committed);
});

/** Holds the store's next write until `open`, then queues `changes` behind it; answers what each queued update came to,
 * and how many times state.json was replaced from the held write on. */
async function queuedBehindAWrite(
  at: Awaited<ReturnType<typeof storeRoot>>,
  changes: ((state: RuntimeState) => void)[],
) {
  let replaced = 0;
  intercept(
    fs,
    "rename",
    (original) =>
      (async (from: string, to: string) => {
        if (to === at.path) replaced++;
        return await original(from, to);
      }) as typeof fs.rename,
  );
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  const { promise: gate, resolve: open } = Promise.withResolvers<void>();
  const held = at.store.update(async (state) => {
    start();
    await gate;
    add("held")(state);
  });
  await started;
  const outcomes = changes.map((change) =>
    at.store.update(change).then(
      async () => ({ saved: names(await new FileStateStore(at.root).read()) }),
      (error: Error) => ({ refused: error.message }),
    ),
  );
  open();
  await held;
  return { outcomes: await Promise.all(outcomes), replaced: () => replaced };
}

test("updates asked for while a write is under way are written together, and each is answered once that write is on disk", async () => {
  const at = await storeRoot();
  await at.store.update(add("first"));
  const { outcomes, replaced } = await queuedBehindAWrite(
    at,
    ["a", "b", "c"].map(add),
  );
  const written = ["first", "held", "a", "b", "c"];
  expect(outcomes).toEqual([
    { saved: written },
    { saved: written },
    { saved: written },
  ]);
  expect(replaced()).toBe(2);
});

test("a change written with others that fails, or leaves the state invalid, is undone and refused alone", async () => {
  const at = await storeRoot();
  await at.store.update(add("first"));
  const { outcomes, replaced } = await queuedBehindAWrite(at, [
    add("a"),
    (state) => {
      add("partial")(state);
      throw new Error("refused part-way");
    },
    (state) => {
      add("invalid")(state);
      (state as { targets: unknown }).targets = 1;
    },
    add("b"),
  ]);
  const written = ["first", "held", "a", "b"];
  expect(outcomes).toMatchObject([
    { saved: written },
    { refused: "refused part-way" },
    { refused: expect.any(String) },
    { saved: written },
  ]);
  expect(replaced()).toBe(2);
});

/** Writes `a`, `b` and `c` together behind a held write, and holds each flush of that shared write until the test lets it
 * go (`next`): what each update came to is in `settled` as soon as it settles. */
async function heldSharedWrite(at: Awaited<ReturnType<typeof storeRoot>>) {
  const flushes: {
    release: () => void;
    fail: () => void;
  }[] = [];
  let arrived = Promise.withResolvers<void>();
  let holding = false;
  intercept(
    await fileHandleClass(),
    "sync",
    (original) =>
      async function (this: fs.FileHandle) {
        if (holding) {
          const { promise, resolve, reject } = Promise.withResolvers<void>();
          flushes.push({
            release: resolve,
            fail: () =>
              reject(
                Object.assign(new Error("injected flush failure"), {
                  code: "EIO",
                }),
              ),
          });
          arrived.resolve();
          await promise;
        }
        return original.call(this);
      },
  );
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  const { promise: gate, resolve: open } = Promise.withResolvers<void>();
  const first = at.store.update(async (state) => {
    start();
    await gate;
    add("held")(state);
  });
  await started;
  const settled: string[] = [];
  const updates = ["a", "b", "c"].map((name) =>
    at.store.update(add(name)).then(
      () => settled.push(`${name} saved`),
      (error: { code?: string }) =>
        settled.push(`${name} refused ${error.code}`),
    ),
  );
  open();
  await first;
  // The shared write has done no I/O yet, so each of its flushes is held from here on.
  holding = true;
  return {
    settled,
    updates,
    /** The next flush of the shared write, once it is held. */
    async next() {
      while (!flushes.length) {
        arrived = Promise.withResolvers<void>();
        await arrived.promise;
      }
      return flushes.shift()!;
    },
  };
}

test("a write that holds several changes answers none of them until its file and every directory up to the root are flushed", async () => {
  const at = await storeRoot();
  await at.store.update(add("first"));
  const write = await heldSharedWrite(at);
  for (const flush of ["file", "runtime directory", "root directory"]) {
    const held = await write.next();
    expect({ flush, settled: write.settled }).toEqual({ flush, settled: [] });
    held.release();
  }
  await Promise.all(write.updates);
  expect(write.settled).toEqual(["a saved", "b saved", "c saved"]);
});

test("a flush that fails in a write that holds several changes fails every one of them", async () => {
  for (const [failing, code, saved] of [
    [0, "EIO", ["first", "held"]],
    [1, "FILE_NOT_DURABLE", ["first", "held", "a", "b", "c"]],
    [2, "FILE_NOT_DURABLE", ["first", "held", "a", "b", "c"]],
  ] as const) {
    const at = await storeRoot();
    await at.store.update(add("first"));
    const write = await heldSharedWrite(at);
    for (let flush = 0; flush < failing; flush++)
      (await write.next()).release();
    (await write.next()).fail();
    await Promise.all(write.updates);
    for (const restore of restores.splice(0)) restore();
    expect({ failing, settled: write.settled }).toEqual({
      failing,
      settled: ["a", "b", "c"].map((name) => `${name} refused ${code}`),
    });
    expect({
      failing,
      saved: names(await new FileStateStore(at.root).read()),
    }).toEqual({ failing, saved: [...saved] });
  }
});

test("an update asked for at any moment after the write before it is answered is written too", async () => {
  const at = await storeRoot();
  const written: string[] = [];
  // However many turns later the next update comes, it never lands between the last look at the queue and the end of
  // the write that looked.
  for (let turns = 0; turns < 8; turns++) {
    await at.store.update(add(`after-${turns}`));
    written.push(`after-${turns}`);
    for (let turn = 0; turn < turns; turn++) await null;
  }
  expect(names(await new FileStateStore(at.root).read())).toEqual(written);
}, 5000);

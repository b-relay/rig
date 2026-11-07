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

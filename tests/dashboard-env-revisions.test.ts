import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { basic, local, SITE } from "./support/dashboard-site";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editProjectConfig,
  previewProjectConfig,
  readProjectConfigSource,
} from "../src/config/documents";
import { parseEnvironmentFile } from "../src/adapters/env-file";
import { createConfigEditor } from "../src/daemon/config-editor";
import { createEnvEditor } from "../src/daemon/env-editor";
import { processStartTime } from "../src/daemon/process-identity";
import { startControlPlane } from "../src/daemon/server";
import { fileNamed, layeredKeys, scopeKey } from "../web/lib/env";
import {
  EMPTY_DRAFT,
  drift,
  keepReveal,
  rebase,
  revealedValue,
  saveRequest,
  stage,
  type Revealed,
} from "../web/lib/env-draft";
import {
  draftOf,
  draftPatch,
  followRead,
  setAt,
  type Tree,
} from "../web/lib/config-form";
import type { EnvFileView, EnvFiles } from "../web/lib/types";

/** The dashboard's env and config editors against rigd's real control plane: the Server Actions a signed-in page on this
 * Mac runs, admission included, and a second writer posting to the same control plane with its token, as any client of
 * rigd does. The page's draft and reveals are the pure models the editors keep their state in. */

mock.module("next/headers", () => ({
  headers: async () => new Headers({ ...local(), authorization: basic() }),
  cookies: async () => ({ get: () => undefined, set() {} }),
}));
const { runConfigEdit, runEnvEdit } = await import("../web/server/actions");

const TOKEN = "env-revisions-token";
type Registration = { id: string; name: string; repoPath: string };
const registry = new Map<string, Registration>();
/** Runs inside the env editor's Project lock, before the write: a registration change finishing while it waited. */
let whileWaiting: (() => void) | undefined;
let scratch: string;
let repo: string;
let server: ReturnType<typeof startControlPlane>;
const envRoot = join(SITE.root, "env");

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "rig-env-revisions-"));
  repo = join(scratch, "repo");
  await mkdir(repo);
  await writeFile(
    join(repo, "rig.yaml"),
    [
      "name: demo",
      "description: As first written.",
      "services:",
      "  api:",
      "    command: serve",
      "jobs:",
      "  db-backup:",
      "    command: dump",
      "    schedule: 0 3 * * *",
      "    backup:",
      "      keep: 3",
      "      restore: restore",
      "targets: { working: true, stable: true, preview: true }",
      "",
    ].join("\n"),
  );
  const resolveProject = async (name: string) => registry.get(name);
  server = startControlPlane({
    port: 0,
    token: TOKEN,
    instanceId: "env-revisions",
    handle: async () => ({}),
    editor: createConfigEditor({
      resolveProject,
      documents: {
        read: readProjectConfigSource,
        preview: previewProjectConfig,
        apply: editProjectConfig,
      },
      exclusive: (_project, operation) => operation(),
    }),
    env: createEnvEditor({
      envRoot,
      resolveProject,
      async declared(repoPath) {
        const { config } = await readProjectConfigSource(repoPath);
        return {
          services: Object.keys(config.services ?? {}).sort(),
          jobs: Object.keys(config.jobs ?? {}).sort(),
        };
      },
      exclusive: async (_project, operation) => {
        whileWaiting?.();
        return operation();
      },
      record: async () => {},
      now: () => new Date().toISOString(),
      id: () => crypto.randomUUID(),
    }),
  });
  // The site's rigd is this control plane, recorded as the process that runs it.
  await mkdir(join(SITE.root, "daemon"), { recursive: true });
  await writeFile(
    join(SITE.root, "daemon", "address.json"),
    JSON.stringify({
      port: server.port,
      instanceId: "env-revisions",
      pid: process.pid,
      startedAt: await processStartTime(process.pid),
    }),
  );
  await writeFile(join(SITE.root, "auth", "control-plane.token"), TOKEN);
});
afterAll(async () => {
  await server.stop(true);
  await rm(join(SITE.root, "daemon"), { recursive: true, force: true });
  await rm(join(SITE.root, "auth", "control-plane.token"), { force: true });
  await rm(envRoot, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});
/** A fresh Project registration and env tree for one test. */
async function fresh(): Promise<void> {
  whileWaiting = undefined;
  registry.clear();
  registry.set("demo", { id: "p1", name: "demo", repoPath: repo });
  await rm(envRoot, { recursive: true, force: true });
}

/** What the dashboard's page reads: every env file, as a refresh hands them to the editor. */
async function page(): Promise<EnvFiles> {
  const outcome = await runEnvEdit({ action: "read", project: "demo" });
  if (!outcome.ok) throw new Error(outcome.failure.message);
  return outcome.value as EnvFiles;
}
const shown = async (key = ":all"): Promise<EnvFileView> =>
  fileNamed((await page()).files, key);
/** Another writer, posting to rigd's control plane with its token. */
async function elsewhere(body: unknown): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/env`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as {
    result?: unknown;
    error?: { message: string };
  };
  if (!response.ok) throw new Error(payload.error?.message);
  return payload.result;
}
/** Sets names in a file from elsewhere, against the revision it has now. */
async function changeElsewhere(
  scope: EnvFileView["scope"],
  changes: unknown[],
): Promise<void> {
  const file = fileNamed((await page()).files, scopeKey(scope));
  await elsewhere({
    action: "write",
    project: "demo",
    scope,
    expectedRevision: file.revision,
    changes,
    actor: "rig (this Mac)",
  });
}
async function values(scope: EnvFileView["scope"] = {}) {
  const path = fileNamed((await page()).files, scopeKey(scope)).path;
  return parseEnvironmentFile(await readFile(path, "utf8"), path);
}

test("two writers race: the dashboard's draft, made against the older file, is refused with what changed, and the other value stays", async () => {
  await fresh();
  await changeElsewhere({}, [{ op: "set", key: "A", value: "first" }]);
  const cases = [
    {
      what: "the same name changed",
      change: { op: "set", key: "A", value: "external-update" },
      moved: { added: [], removed: [] },
    },
    {
      what: "the name removed",
      change: { op: "remove", key: "A" },
      moved: { added: [], removed: ["A"] },
    },
    {
      what: "another name added",
      change: { op: "set", key: "B", value: "unrelated" },
      moved: { added: ["B"], removed: [] },
    },
  ];
  for (const { what, change, moved } of cases) {
    // The operator stages an edit on the file as the page read it.
    const before = await shown();
    const draft = stage(EMPTY_DRAFT, before, "A", {
      op: "set",
      value: "dashboard-draft",
    });
    // Another writer saves first, and a live refresh hands the page the newer file.
    await changeElsewhere({}, [change]);
    const after = await shown();
    const stored = await values();
    expect(drift(draft, after), what).toEqual(moved);
    const refused = await runEnvEdit(saveRequest("demo", draft, after));
    expect(refused, what).toMatchObject({
      ok: false,
      failure: {
        code: "ENV_REVISION_CONFLICT",
        message: expect.stringContaining(
          `it now assigns ${after.keys.join(", ")}`,
        ),
      },
    });
    expect(await values(), what).toEqual(stored);
    // Reviewed against the current file, the same draft saves on it and keeps what the other writer added.
    const saved = await runEnvEdit(
      saveRequest("demo", rebase(draft, after), after),
    );
    expect(saved.ok, what).toBe(true);
    expect(await values(), what).toEqual({ ...stored, A: "dashboard-draft" });
  }
});

test("a live refresh during an unsaved edit keeps the draft, flagged as made against the older file", async () => {
  await fresh();
  await changeElsewhere({}, [{ op: "set", key: "A", value: "first" }]);
  const before = await shown();
  let draft = stage(EMPTY_DRAFT, before, "A", { op: "set", value: "mine" });
  draft = stage(draft, before, "NEW", { op: "set", value: "added" });
  expect(drift(draft, before)).toBeUndefined();
  await changeElsewhere({}, [{ op: "set", key: "C", value: "theirs" }]);
  const after = await shown();
  // The page now shows the newer file; the draft is what it was, made against the file it was staged on.
  expect(after.keys).toEqual(["A", "C"]);
  expect(draft.pending).toEqual({
    A: { op: "set", value: "mine" },
    NEW: { op: "set", value: "added" },
  });
  expect(saveRequest("demo", draft, after).expectedRevision).toBe(
    before.revision,
  );
  expect(drift(draft, after)).toEqual({ added: ["C"], removed: [] });
  // Undoing every change leaves nothing to flag, and the next edit starts from the file shown then.
  draft = stage(stage(draft, after, "A", undefined), after, "NEW", undefined);
  expect(draft).toEqual({ pending: {}, revealed: {} });
  expect(
    saveRequest("demo", stage(draft, after, "A", { op: "remove" }), after)
      .expectedRevision,
  ).toBe(after.revision);
});

test("a value revealed before an external change is masked once the page reads the newer file, and a late reply never shows", async () => {
  await fresh();
  await changeElsewhere({}, [
    { op: "set", key: "AUDIT_PROJECT_ALL", value: "present" },
  ]);
  const reveal = async () => {
    const outcome = await runEnvEdit({
      action: "reveal",
      project: "demo",
      scope: {},
      key: "AUDIT_PROJECT_ALL",
    });
    if (!outcome.ok) throw new Error(outcome.failure.message);
    return outcome.value as { value: string; revision: string };
  };
  const before = await shown();
  let revealed: Record<string, Revealed> = keepReveal(
    {},
    "AUDIT_PROJECT_ALL",
    {},
    before.revision,
    await reveal(),
  );
  expect(
    revealedValue(revealed, "AUDIT_PROJECT_ALL", {}, before.revision),
  ).toBe("present");
  await changeElsewhere({}, [
    { op: "set", key: "AUDIT_PROJECT_ALL", value: "external-current" },
  ]);
  const after = await shown();
  expect(
    revealedValue(revealed, "AUDIT_PROJECT_ALL", {}, after.revision),
  ).toBeUndefined();
  // A reply that reads the newer file while the page still shows the older one is not kept: the page reads again.
  const newer = await reveal();
  expect(newer).toEqual({
    value: "external-current",
    revision: after.revision,
  });
  expect(
    keepReveal({}, "AUDIT_PROJECT_ALL", {}, before.revision, newer),
  ).toEqual({});
  // A reply for the older revision that lands after the refresh is kept against that revision only, so it stays masked.
  revealed = keepReveal({}, "AUDIT_PROJECT_ALL", {}, before.revision, {
    value: "present",
    revision: before.revision,
  });
  expect(
    revealedValue(revealed, "AUDIT_PROJECT_ALL", {}, after.revision),
  ).toBeUndefined();
});

test("a Target's revealed value is masked once another file wins it, and its source label never pairs with an older value", async () => {
  await fresh();
  await changeElsewhere({ service: "api" }, [
    { op: "set", key: "AUDIT_LAYER", value: "service-all" },
  ]);
  const winner = (files: readonly EnvFileView[]) =>
    layeredKeys(files, "stable", { service: "api" }).find(
      (each) => each.key === "AUDIT_LAYER",
    )!;
  const before = winner((await page()).files);
  expect(before.from).toEqual({ service: "api" });
  const reply = await runEnvEdit({
    action: "reveal",
    project: "demo",
    scope: before.from,
    key: before.key,
  });
  const revealed = keepReveal(
    {},
    before.key,
    before.from,
    before.revision,
    (reply as { value: { value: string; revision: string } }).value,
  );
  expect(
    revealedValue(revealed, before.key, before.from, before.revision),
  ).toBe("service-all");
  await changeElsewhere({ service: "api", role: "stable" }, [
    { op: "set", key: "AUDIT_LAYER", value: "service-stable-current" },
  ]);
  const after = winner((await page()).files);
  expect(after.from).toEqual({ service: "api", role: "stable" });
  expect(
    revealedValue(revealed, after.key, after.from, after.revision),
  ).toBeUndefined();
});

test("a rename that finishes while the dashboard's save waits for the Project's lock refuses the save, and nothing is written", async () => {
  await fresh();
  const before = await shown();
  const draft = stage(EMPTY_DRAFT, before, "A", { op: "set", value: "x" });
  whileWaiting = () => {
    const demo = registry.get("demo")!;
    registry.delete("demo");
    registry.set("pantry", { ...demo, name: "pantry" });
  };
  expect(await runEnvEdit(saveRequest("demo", draft, before))).toMatchObject({
    ok: false,
    failure: { code: "PROJECT_MISSING" },
  });
  expect(
    await readFile(join(envRoot, "demo", "all.env"), "utf8").catch(() => null),
  ).toBeNull();
});

test("a Job's env files are listed beside the Services', and are revealed and saved from the dashboard", async () => {
  await fresh();
  const files = await page();
  expect(files.jobs).toEqual(["db-backup"]);
  expect(
    files.files
      .filter((file) => file.scope.job)
      .map((file) => scopeKey(file.scope)),
  ).toEqual([
    "db-backup:all",
    "db-backup:working",
    "db-backup:stable",
    "db-backup:preview",
  ]);
  const stable = fileNamed(files.files, "db-backup:stable");
  expect(stable.path).toBe(join(envRoot, "demo", "db-backup", "stable.env"));
  const draft = stage(EMPTY_DRAFT, stable, "PGPASSWORD", {
    op: "set",
    value: "job-stable",
  });
  expect(await runEnvEdit(saveRequest("demo", draft, stable))).toMatchObject({
    ok: true,
    value: {
      scope: { job: "db-backup", role: "stable" },
      keys: ["PGPASSWORD"],
    },
  });
  expect(await values({ job: "db-backup", role: "stable" })).toEqual({
    PGPASSWORD: "job-stable",
  });
  expect(
    await runEnvEdit({
      action: "reveal",
      project: "demo",
      scope: { job: "db-backup", role: "stable" },
      key: "PGPASSWORD",
    }),
  ).toMatchObject({ ok: true, value: { value: "job-stable" } });
  // A Target's view layers the Job's files after the Project's, as its runs and restores load them.
  expect(
    layeredKeys((await page()).files, "stable", { job: "db-backup" }),
  ).toMatchObject([
    { key: "PGPASSWORD", from: { job: "db-backup", role: "stable" } },
  ]);
});

test("a live refresh keeps an unsaved config edit against the file it was made on, until a review replays it on the newer file", async () => {
  await fresh();
  const readConfig = async () => {
    const outcome = await runConfigEdit({ action: "read", project: "demo" });
    if (!outcome.ok) throw new Error(outcome.failure.message);
    const read = outcome.value as { revision: string; config: Tree };
    return { revision: read.revision, config: read.config };
  };
  const yaml = join(repo, "rig.yaml");
  const original = await readFile(yaml, "utf8");
  try {
    const first = await readConfig();
    const draft = {
      ...draftOf(first),
      tree: setAt(first.config, ["description"], "UNSAVED AUDIT DRAFT"),
    };
    // Another editor changes the same field and another one; a live refresh hands the page the newer file.
    await writeFile(
      yaml,
      original
        .replace("As first written.", "Changed elsewhere.")
        .replace("keep: 3", "keep: 5"),
    );
    const second = await readConfig();
    const kept = followRead(draft, second);
    expect(kept).toBe(draft);
    expect(draftPatch(kept)).toEqual([
      { op: "set", path: ["description"], value: "UNSAVED AUDIT DRAFT" },
    ]);
    // Sent as made, against the older file, it is refused rather than applied over the newer one.
    expect(
      await runConfigEdit({
        action: "preview",
        project: "demo",
        expectedRevision: kept.base.revision,
        patch: draftPatch(kept),
      }),
    ).toMatchObject({ ok: false, failure: { code: "REVISION_CONFLICT" } });
    // A review replays it on the newer file, showing the field's value there, and applying keeps the other change.
    const replayed = followRead(kept, second, true);
    const preview = await runConfigEdit({
      action: "preview",
      project: "demo",
      expectedRevision: replayed.base.revision,
      patch: draftPatch(replayed),
    });
    expect(preview).toMatchObject({
      ok: true,
      value: {
        diff: [
          {
            path: "description",
            before: "Changed elsewhere.",
            after: "UNSAVED AUDIT DRAFT",
          },
        ],
      },
    });
    const applied = await runConfigEdit({
      action: "apply",
      project: "demo",
      expectedRevision: replayed.base.revision,
      patch: draftPatch(replayed),
    });
    expect(applied.ok).toBe(true);
    const written = (await readProjectConfigSource(repo)).config;
    expect(written.description).toBe("UNSAVED AUDIT DRAFT");
    expect(written.jobs?.["db-backup"]?.backup?.keep).toBe(5);
    // What rigd wrote becomes the base, so the refresh that reads it back has nothing left to keep.
    const result = (
      applied as { value: { nextRevision: string; config: Tree } }
    ).value;
    const adopted = draftOf({
      revision: result.nextRevision,
      config: result.config,
    });
    expect(followRead(adopted, await readConfig())).toBe(adopted);
    expect(draftPatch(adopted)).toEqual([]);
    // With nothing edited, a refresh simply follows the newer file.
    const untouched = draftOf(await readConfig());
    await writeFile(yaml, original);
    const third = await readConfig();
    expect(followRead(untouched, third)).toEqual(draftOf(third));
  } finally {
    await writeFile(yaml, original);
  }
});

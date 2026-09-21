import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigEditor } from "../src/daemon/config-editor.js";
import {
  editProjectConfig,
  previewProjectConfig,
  readProjectConfigSource,
} from "../src/config/documents.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(
  raw = "# Project\nname: pantry\nservices:\n  web:\n    run: serve # keep this\n",
) {
  const root = await mkdtemp(join(tmpdir(), "rig-editor-"));
  roots.push(root);
  const path = join(root, "rig.yaml");
  await writeFile(path, raw);
  let locks = 0;
  const editor = createConfigEditor({
    resolveProject: async (name) =>
      name === "pantry" ? { name, repoPath: root } : undefined,
    documents: {
      read: readProjectConfigSource,
      preview: previewProjectConfig,
      apply: editProjectConfig,
    },
    exclusive: async (operation) => {
      locks++;
      return operation();
    },
  });
  return { root, path, raw, editor, locks: () => locks };
}
test("registered config preview is pure and apply matches preview with comments, backup and revision protection", async () => {
  const f = await fixture();
  const read = await f.editor({ action: "read", project: "pantry" });
  expect(read).toMatchObject({ project: "pantry", raw: f.raw });
  expect(read.fields?.some((field) => field.path === "services.*.run")).toBe(
    true,
  );
  const request = {
    project: "pantry",
    expectedRevision: read.revision,
    patch: [
      {
        op: "set",
        path: ["services", "web", "run"],
        value: "serve --port 3000",
      },
    ],
  };
  const preview = await f.editor({ action: "preview", ...request });
  if (!("nextRevision" in preview)) throw new Error("Expected edit preview");
  expect(preview.raw).toContain("serve --port 3000 # keep this");
  expect(await readdir(f.root)).toEqual(["rig.yaml"]);
  expect(await readFile(f.path, "utf8")).toBe(f.raw);
  expect(f.locks()).toBe(0);
  const applied = await f.editor({ action: "apply", ...request });
  if (!("backupPath" in applied) || typeof applied.backupPath !== "string")
    throw new Error("Expected applied edit");
  expect(applied).toMatchObject({
    applied: true,
    baseRevision: read.revision,
    nextRevision: preview.nextRevision,
  });
  expect(await readFile(f.path, "utf8")).toBe(preview.raw);
  expect(await readFile(applied.backupPath!, "utf8")).toBe(f.raw);
  expect(f.locks()).toBe(1);
  await expect(f.editor({ action: "apply", ...request })).rejects.toMatchObject(
    { code: "revision_conflict" },
  );
});

test("editor rejects unregistered identities, arbitrary paths, identity edits and unsupported schema keys before writing", async () => {
  const f = await fixture();
  const read = await f.editor({ action: "read", project: "pantry" });
  await expect(
    f.editor({ action: "read", project: "elsewhere" }),
  ).rejects.toMatchObject({ code: "project_missing" });
  await expect(
    f.editor({
      action: "read",
      project: "pantry",
      configPath: "/tmp/other/rig.yaml",
    }),
  ).rejects.toMatchObject({ code: "invalid_edit" });
  for (const path of [
    ["name"],
    ["constructor", "prototype"],
    ["services", "web", "unknown"],
    ["services", "BAD_NAME", "run"],
    ["components", "web", "command"],
    ["missing"],
    ["toString"],
    ["services", "web", "depends_on", "0"],
  ]) {
    await expect(
      f.editor({
        action: "apply",
        project: "pantry",
        expectedRevision: read.revision,
        patch: [{ op: "remove", path }],
      }),
    ).rejects.toMatchObject({
      code: path[0] === "name" ? "identity_change" : "invalid_edit",
    });
  }
  expect(await readdir(f.root)).toEqual(["rig.yaml"]);
  expect(await readFile(f.path, "utf8")).toBe(f.raw);
  expect(f.locks()).toBe(0);
});

test("YAML scalar removal preserves unrelated comments and refuses attached comments or collection replacement", async () => {
  const f = await fixture(
    "# Project\nname: pantry\ndescription: optional\nservices:\n  web:\n    run: serve\n    ready: curl localhost # keep explanation\n",
  );
  const read = await f.editor({ action: "read", project: "pantry" });
  const request = { project: "pantry", expectedRevision: read.revision };
  for (const patch of [
    [{ op: "remove", path: ["services", "web", "ready"] }],
    [{ op: "remove", path: ["services", "web"] }],
    [{ op: "set", path: ["services"], value: {} }],
  ])
    await expect(
      f.editor({ action: "preview", ...request, patch }),
    ).rejects.toMatchObject({ code: "lossy_edit" });
  const result = await f.editor({
    action: "apply",
    ...request,
    patch: [
      { op: "remove", path: ["description"] },
      { op: "remove", path: ["targets", "working", "env", "UNSET"] },
    ],
  });
  expect(result.raw).not.toContain("description:");
  expect(result.raw).toContain("# Project");
  expect(result.raw).toContain("ready: curl localhost # keep explanation");
});

test("apply rejects an invalid domain value without a write", async () => {
  const f = await fixture();
  const read = await f.editor({ action: "read", project: "pantry" });
  const request = { project: "pantry", expectedRevision: read.revision };
  await expect(
    f.editor({
      action: "apply",
      ...request,
      patch: [
        { op: "set", path: ["services", "web", "ports", "http"], value: 0 },
      ],
    }),
  ).rejects.toMatchObject({ code: "invalid_config" });
  expect(await readdir(f.root)).toEqual(["rig.yaml"]);
  expect(await readFile(f.path, "utf8")).toBe(f.raw);
});

test("registration resolution occurs inside the runtime mutation gate for apply", async () => {
  const f = await fixture();
  const read = await readProjectConfigSource(f.root);
  let inGate = false;
  const editor = createConfigEditor({
    resolveProject: async (name) => {
      expect(inGate).toBe(true);
      return { name, repoPath: f.root };
    },
    documents: {
      read: readProjectConfigSource,
      preview: previewProjectConfig,
      apply: editProjectConfig,
    },
    exclusive: async (operation) => {
      inGate = true;
      try {
        return await operation();
      } finally {
        inGate = false;
      }
    },
  });
  await editor({
    action: "apply",
    project: "pantry",
    expectedRevision: read.revision,
    patch: [{ op: "set", path: ["description"], value: "updated" }],
  });
  expect(inGate).toBe(false);
});

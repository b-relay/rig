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
  raw = "# Project\nname: pantry\ncomponents:\n  web:\n    mode: managed\n    command: serve # keep this\n",
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
  expect(
    read.fields?.some((field) => field.path === "components.*.command"),
  ).toBe(true);
  const request = {
    project: "pantry",
    expectedRevision: read.revision,
    patch: [
      {
        op: "set",
        path: ["components", "web", "command"],
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
    ["components", "web", "unknown"],
    ["components", "BAD_NAME", "command"],
    ["missing"],
    ["toString"],
    ["components", "web", "dependsOn", "0"],
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
    "# Project\nname: pantry\ndescription: optional\ncomponents:\n  web:\n    mode: managed\n    command: serve\n    health: curl localhost # keep explanation\n",
  );
  const read = await f.editor({ action: "read", project: "pantry" });
  const request = { project: "pantry", expectedRevision: read.revision };
  for (const patch of [
    [{ op: "remove", path: ["components", "web", "health"] }],
    [{ op: "remove", path: ["components", "web"] }],
    [{ op: "set", path: ["components"], value: {} }],
  ])
    await expect(
      f.editor({ action: "preview", ...request, patch }),
    ).rejects.toMatchObject({ code: "lossy_edit" });
  const result = await f.editor({
    action: "apply",
    ...request,
    patch: [
      { op: "remove", path: ["description"] },
      { op: "remove", path: ["local", "env", "UNSET"] },
    ],
  });
  expect(result.raw).not.toContain("description:");
  expect(result.raw).toContain("# Project");
  expect(result.raw).toContain("health: curl localhost # keep explanation");
});

test("JSON preview/apply use original bytes for backups and reject invalid domain values without a write", async () => {
  const f = await fixture();
  await rm(f.path);
  const jsonPath = join(f.root, "rig.json");
  const original = JSON.stringify({
    name: "pantry",
    description: "remove",
    components: { web: { mode: "managed", command: "serve" } },
  });
  await writeFile(jsonPath, original);
  const read = await f.editor({ action: "read", project: "pantry" });
  const request = { project: "pantry", expectedRevision: read.revision };
  await expect(
    f.editor({
      action: "apply",
      ...request,
      patch: [{ op: "set", path: ["components", "web", "port"], value: 0 }],
    }),
  ).rejects.toMatchObject({ code: "invalid_config" });
  expect(await readdir(f.root)).toEqual(["rig.json"]);
  const patch = [
    { op: "remove", path: ["description"] },
    { op: "remove", path: ["local", "env", "NOT_SET"] },
    { op: "set", path: ["components", "web", "env", "MODE"], value: "local" },
  ];
  const preview = await f.editor({ action: "preview", ...request, patch });
  const result = await f.editor({ action: "apply", ...request, patch });
  if (
    !("nextRevision" in preview) ||
    !("backupPath" in result) ||
    typeof result.backupPath !== "string"
  )
    throw new Error("Expected preview and applied edit");
  expect(result.nextRevision).toBe(preview.nextRevision);
  expect(JSON.parse(result.raw)).toEqual({
    name: "pantry",
    components: {
      web: { mode: "managed", command: "serve", env: { MODE: "local" } },
    },
  });
  expect(await readFile(result.backupPath!, "utf8")).toBe(original);
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

import { test, expect } from "bun:test";
import { parseDocument } from "yaml";
import { applyYamlEdits } from "../src/config/editor";
import {
  applyPatch,
  configPatch,
  fieldFor,
  KEY_PATTERN,
  keyAllowed,
  parseLines,
  parseList,
  parsePort,
  removeAt,
  setAt,
  type Tree,
} from "../web/dashboard/config-form";

const pantry = {
  name: "pantry",
  production_branch: "main",
  services: {
    web: { run: "bun server.ts", ports: { http: 4310 }, env: { PORT: "1" } },
  },
  targets: { working: { name: "local" } },
};

test("an unchanged draft yields no edits", () => {
  expect(configPatch(pantry, structuredClone(pantry))).toEqual([]);
});

test("changed scalars become leaf sets and absent ones are removed", () => {
  const draft = setAt(
    removeAt(pantry, ["production_branch"]),
    ["services", "web", "run"],
    "bun start",
  );
  expect(configPatch(pantry, draft)).toEqual([
    { op: "remove", path: ["production_branch"] },
    { op: "set", path: ["services", "web", "run"], value: "bun start" },
  ]);
});

test("a subtree new on one side is one edit at its root", () => {
  const added = setAt(pantry, ["tools", "cli"], { bin: "dist/cli" });
  expect(configPatch(pantry, added)).toEqual([
    { op: "set", path: ["tools"], value: { cli: { bin: "dist/cli" } } },
  ]);
  const second = setAt(added, ["tools", "fmt"], { bin: "dist/fmt" });
  expect(configPatch(added, second)).toEqual([
    { op: "set", path: ["tools", "fmt"], value: { bin: "dist/fmt" } },
  ]);
  const cleared = removeAt(pantry, ["services", "web", "env", "PORT"]);
  expect(cleared.services).toEqual({
    web: { run: "bun server.ts", ports: { http: 4310 } },
  });
  expect(configPatch(pantry, cleared)).toEqual([
    { op: "remove", path: ["services", "web", "env"] },
  ]);
});

test("arrays are leaves and a scalar replaced by an object is one set", () => {
  const original = { env_file: ".env", services: { a: { depends_on: ["b"] } } };
  const draft = {
    env_file: [".env", ".env.local"],
    services: { a: { depends_on: ["b", "c"] } },
  };
  expect(configPatch(original, draft)).toEqual([
    { op: "set", path: ["env_file"], value: [".env", ".env.local"] },
    { op: "set", path: ["services", "a", "depends_on"], value: ["b", "c"] },
  ]);
});

test("removing the last key of a nested record prunes the emptied parents but never the root", () => {
  const tree = { name: "x", targets: { working: { env: { A: "1" } } } };
  expect(removeAt(tree, ["targets", "working", "env", "A"])).toEqual({
    name: "x",
  });
  expect(removeAt({ name: "x" }, ["name"])).toEqual({});
  expect(removeAt(tree, ["missing", "key"])).toBe(tree);
});

test("field help matches record keys against wildcards, preferring the exact path", () => {
  const fields = [
    { path: "services.*.env.*", description: "Service env", valueShape: "s" },
    { path: "env.*", description: "Project env", valueShape: "s" },
    { path: "targets.working.name", description: "Working", valueShape: "s" },
    { path: "targets.*.name", description: "Any", valueShape: "s" },
  ];
  expect(
    fieldFor(fields, ["services", "web", "env", "PORT"])?.description,
  ).toBe("Service env");
  expect(fieldFor(fields, ["targets", "working", "name"])?.description).toBe(
    "Working",
  );
  expect(fieldFor(fields, ["targets", "stable", "name"])?.description).toBe(
    "Any",
  );
  expect(fieldFor(fields, ["services", "web"])).toBeUndefined();
});

test("form text parses into the config's value shapes", () => {
  expect(parsePort("")).toBe("auto");
  expect(parsePort(" 3000 ")).toBe(3000);
  expect(parsePort("http")).toBe("http");
  expect(parseList("a, b,,c ")).toEqual(["a", "b", "c"]);
  expect(parseLines("")).toBeUndefined();
  expect(parseLines(".env\n")).toBe(".env");
  expect(parseLines(".env\n.env.local")).toEqual([".env", ".env.local"]);
});

test("every edit the editor generates is one rigd applies to the written rig.yaml", () => {
  const raw =
    "# schema\nname: pantry\nservices:\n  web:\n    run: bun server.ts\n    ports:\n      http: 4310\n    env:\n      PORT: '1'\n    depends_on: [db]\n  db:\n    run: postgres\ntools:\n  cli:\n    bin: dist/cli\n";
  const drafts: Record<string, (tree: Tree) => Tree> = {
    "clear the last env var": (tree) =>
      removeAt(tree, ["services", "web", "env", "PORT"]),
    "remove a Service": (tree) => removeAt(tree, ["services", "db"]),
    "remove every Tool": (tree) => removeAt(tree, ["tools", "cli"]),
    "edit a list": (tree) =>
      setAt(tree, ["services", "web", "depends_on"], ["db", "cache"]),
    "add a Service": (tree) => setAt(tree, ["services", "api"], { run: "x" }),
  };
  for (const [name, change] of Object.entries(drafts)) {
    const document = parseDocument(raw);
    const original = document.toJS() as Tree;
    const patch = configPatch(original, change(original));
    expect(patch.length, name).toBeGreaterThan(0);
    expect(() => applyYamlEdits(document, patch), name).not.toThrow();
    expect(document.toJS(), name).toEqual(change(original));
  }
});

test("new record keys must match the schema pattern, be unused, and not alias object internals", () => {
  expect(keyAllowed(KEY_PATTERN, "cache", ["web"])).toBe(true);
  expect(keyAllowed(KEY_PATTERN, "web", ["web"])).toBe(false);
  expect(keyAllowed(KEY_PATTERN, "Cache", [])).toBe(false);
  expect(keyAllowed(KEY_PATTERN, "constructor", [])).toBe(false);
  expect(keyAllowed(/^[A-Za-z_][A-Za-z0-9_]*$/, "__proto__", [])).toBe(false);
});

test("edits replayed onto a newer read keep what changed on disk", () => {
  const draft = setAt(
    removeAt(pantry, ["production_branch"]),
    ["description"],
    "Demo",
  );
  const edits = configPatch(pantry, draft);
  const newer = { ...pantry, domain: "pantry.test" };
  const rebased = applyPatch(newer, edits);
  expect(rebased.domain).toBe("pantry.test");
  expect(configPatch(newer, rebased)).toEqual(edits);
});

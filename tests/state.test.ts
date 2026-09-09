import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateStore } from "../src/runtime/state-store";

test("registration survives reopening and serialized concurrent updates preserve both projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-state-"));
  try {
    const store = new FileStateStore(root);
    await Promise.all(
      ["alpha", "beta"].map((name) =>
        store.update((state) => {
          state.projects.push({
            id: name,
            name,
            repoPath: `/repos/${name}`,
            configPath: `/repos/${name}/rig.yaml`,
            createdAt: "2026-09-09T00:00:00Z",
          });
        }),
      ),
    );
    const reopened = await new FileStateStore(root).read();
    expect(reopened.projects.map((p) => p.name).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    expect(
      JSON.parse(await readFile(join(root, "runtime", "state.json"), "utf8"))
        .version,
    ).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt state fails closed and is never replaced with an empty inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-state-"));
  try {
    await mkdir(join(root, "runtime"));
    await writeFile(join(root, "runtime", "state.json"), "{broken");
    const store = new FileStateStore(root);
    await expect(
      store.update((s) => {
        s.projects = [];
      }),
    ).rejects.toThrow("runtime state");
    expect(await readFile(join(root, "runtime", "state.json"), "utf8")).toBe(
      "{broken",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valid JSON with an incomplete saved Target plan fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-state-corrupt-plan-"));
  try {
    await mkdir(join(root, "runtime"), { recursive: true });
    const content = JSON.stringify({
      version: 2,
      projects: [
        {
          id: "p",
          name: "demo",
          repoPath: "/tmp/demo",
          configPath: "/tmp/demo/rig.yaml",
          createdAt: "now",
        },
      ],
      targets: [
        {
          id: "t",
          projectId: "p",
          name: "local",
          kind: "local",
          desired: "running",
          createdAt: "now",
          updatedAt: "now",
          logRoot: "/tmp/logs",
          plan: {
            project: "demo",
            workspacePath: "/tmp/demo",
            dataRoot: "/tmp/data",
            components: [{ kind: "managed", name: "web" }],
          },
        },
      ],
      activity: [],
    });
    await writeFile(join(root, "runtime", "state.json"), content);
    await expect(new FileStateStore(root).read()).rejects.toThrow(
      "Invalid runtime state",
    );
    expect(await readFile(join(root, "runtime", "state.json"), "utf8")).toBe(
      content,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

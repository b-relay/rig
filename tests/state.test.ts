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
    ).toBe(3);
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

test("a state file with a relative repository path is refused as corrupt and names the requirement", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-state-relative-path-"));
  try {
    await mkdir(join(root, "runtime"), { recursive: true });
    const content = JSON.stringify({
      version: 3,
      projects: [
        {
          id: "p",
          name: "demo",
          repoPath: "demo",
          configPath: "demo/rig.yaml",
          createdAt: "now",
        },
      ],
      targets: [],
      activity: [],
    });
    await writeFile(join(root, "runtime", "state.json"), content);
    await expect(new FileStateStore(root).read()).rejects.toMatchObject({
      code: "STATE_CORRUPT",
      hint: expect.stringContaining(
        "invalid value at projects.0.repoPath: must be an absolute path",
      ),
    });
    expect(await readFile(join(root, "runtime", "state.json"), "utf8")).toBe(
      content,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a deployed Target recorded before sourceRoot existed is backfilled on read when its workspace sits in the Target's revisions directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-state-sourceroot-"));
  try {
    await mkdir(join(root, "runtime"), { recursive: true });
    const record = (
      id: string,
      kind: "local" | "preview",
      workspacePath: string,
    ) => ({
      id,
      projectId: "p",
      name: id,
      kind,
      desired: "stopped",
      createdAt: "now",
      updatedAt: "now",
      logRoot: join(root, "targets", "p", id, "logs"),
      plan: {
        project: "demo",
        target: kind,
        workspacePath,
        dataRoot: join(root, "targets", "p", id, "data"),
        deploymentName: id,
        branchSlug: id,
        subdomain: "",
        providers: { processSupervisor: "rigd" },
        providerProfile: "default",
        components: [],
        preparedComponents: [],
      },
    });
    await writeFile(
      join(root, "runtime", "state.json"),
      JSON.stringify({
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
          record(
            "inside",
            "preview",
            join(root, "targets", "p", "inside", "revisions", "abc"),
          ),
          record("elsewhere", "preview", "/tmp/somewhere-else"),
          record("local", "local", "/tmp/demo"),
        ],
        activity: [],
      }),
    );
    const state = await new FileStateStore(root).read();
    expect(state.targets.map((t) => [t.id, t.sourceRoot])).toEqual([
      ["inside", join(root, "targets", "p", "inside", "revisions")],
      ["elsewhere", undefined],
      ["local", undefined],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["{broken", "is not valid JSON"],
  ["", "is not valid JSON"],
  ["null", "at the top level"],
  ['{"version":1,"projects":[],"targets":[],"activity":[]}', "at version:"],
  [
    '{"version":2,"projects":[],"targets":[{"id":"t","projectId":"p","name":"local","kind":"local","desired":"running","createdAt":"now","updatedAt":"now","logRoot":"/tmp/logs","plan":{"project":"demo","workspacePath":"/tmp/demo","dataRoot":"/tmp/data","components":[{"kind":"managed","name":"web"}]}}],"activity":[]}',
    "at targets.0.plan.",
  ],
])(
  "corrupt state %j names the file and the problem in its hint",
  async (content, problem) => {
    const root = await mkdtemp(join(tmpdir(), "rig-state-hint-"));
    try {
      await mkdir(join(root, "runtime"));
      const path = join(root, "runtime", "state.json");
      await writeFile(path, content);
      const failure = await new FileStateStore(root).read().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        code: "STATE_CORRUPT",
        details: { path },
      });
      const hint = (failure as { hint: string }).hint;
      expect(hint).toContain(path);
      expect(hint).toContain(problem);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("each update keeps the previous state as state.json.bak, and the corrupt-state hint points at it once it exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-state-backup-"));
  try {
    const store = new FileStateStore(root);
    const path = join(root, "runtime", "state.json");
    const backup = `${path}.bak`;
    await store.update((s) => {
      s.projects.push({
        id: "p",
        name: "alpha",
        repoPath: "/tmp/alpha",
        configPath: "/tmp/alpha/rig.yaml",
        createdAt: "now",
      });
    });
    const first = await readFile(path, "utf8");
    expect(await Bun.file(backup).exists()).toBe(false);
    await store.update((s) => {
      s.projects[0]!.name = "beta";
    });
    expect(await readFile(backup, "utf8")).toBe(first);
    expect(await readFile(path, "utf8")).toContain("beta");
    expect(await Bun.file(`${path}.next`).exists()).toBe(false);
    await writeFile(path, "{broken");
    const failure = (await store.read().then(
      () => undefined,
      (error: unknown) => error,
    )) as { code: string; hint: string };
    expect(failure.code).toBe("STATE_CORRUPT");
    expect(failure.hint).toContain(backup);
    expect(await readFile(backup, "utf8")).toBe(first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const inventory = {
  projects: [
    {
      id: "p",
      name: "demo",
      repoPath: "/tmp/demo",
      configPath: "/tmp/demo/rig.yaml",
      createdAt: "now",
      futureProjectField: "kept",
    },
  ],
  targets: [
    {
      id: "t",
      projectId: "p",
      name: "local",
      kind: "local",
      desired: "stopped",
      createdAt: "now",
      updatedAt: "now",
      logRoot: "/tmp/logs",
      futureTargetField: { nested: true },
      plan: {
        project: "demo",
        target: "local",
        workspacePath: "/tmp/demo",
        dataRoot: "/tmp/data",
        deploymentName: "local",
        branchSlug: "local",
        subdomain: "local",
        providers: { processSupervisor: "child" },
        providerProfile: "default",
        components: [],
        preparedComponents: [],
      },
    },
  ],
  activity: [],
};

test("keys this rigd does not know survive a read-modify-write round trip, so a newer version's fields are not lost through an older one", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-state-passthrough-"));
  try {
    await mkdir(join(root, "runtime"));
    const path = join(root, "runtime", "state.json");
    await writeFile(
      path,
      JSON.stringify({ version: 3, futureTopLevel: [1], ...inventory }),
    );
    const store = new FileStateStore(root);
    expect(await store.read()).toMatchObject({ futureTopLevel: [1] });
    await store.update((s) => {
      s.targets[0]!.desired = "running";
    });
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written).toMatchObject({
      version: 3,
      futureTopLevel: [1],
      projects: [{ futureProjectField: "kept" }],
      targets: [{ desired: "running", futureTargetField: { nested: true } }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a state file written by a newer rigd is refused with both versions named, and a version 2 file is read and rewritten as version 3", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-state-version-"));
  try {
    await mkdir(join(root, "runtime"));
    const path = join(root, "runtime", "state.json");
    const store = new FileStateStore(root);
    await writeFile(path, JSON.stringify({ version: 4, ...inventory }));
    await expect(store.read()).rejects.toMatchObject({
      code: "STATE_VERSION",
      hint: expect.stringMatching(/version 4.*version 3/s),
      details: { path, version: 4, supported: 3 },
    });
    expect(await readFile(path, "utf8")).toContain('"version":4');
    await writeFile(path, JSON.stringify({ version: 2, ...inventory }));
    expect((await store.read()).version).toBe(3);
    await store.update(() => {});
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

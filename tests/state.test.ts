import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateStore } from "../src/runtime/state-store";
import { describeExit } from "../src/runtime/supervision";
import { parseProjectConfig, resolveTargetPlan } from "../src/config";

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
    ).toBe(5);
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
      version: 5,
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
          name: "working",
          kind: "working",
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
      version: 5,
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

test.each([
  ["{broken", "is not valid JSON"],
  ["", "is not valid JSON"],
  ["null", "at the top level"],
  [
    '{"version":5,"projects":[],"targets":[{"id":"t","projectId":"p","name":"working","kind":"working","desired":"running","createdAt":"now","updatedAt":"now","logRoot":"/tmp/logs","plan":{"project":"demo","workspacePath":"/tmp/demo","dataRoot":"/tmp/data","components":[{"kind":"managed","name":"web"}]}}],"activity":[]}',
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
      name: "working",
      kind: "working",
      desired: "stopped",
      createdAt: "now",
      updatedAt: "now",
      logRoot: "/tmp/logs",
      futureTargetField: { nested: true },
      plan: {
        project: "demo",
        target: "working",
        workspacePath: "/tmp/demo",
        dataRoot: "/tmp/data",
        deploymentName: "working",
        branchSlug: "working",
        subdomain: "working",
        providers: { processSupervisor: "child" },
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
      JSON.stringify({ version: 5, futureTopLevel: [1], ...inventory }),
    );
    const store = new FileStateStore(root);
    expect(await store.read()).toMatchObject({ futureTopLevel: [1] });
    await store.update((s) => {
      s.targets[0]!.desired = "running";
    });
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written).toMatchObject({
      version: 5,
      futureTopLevel: [1],
      projects: [{ futureProjectField: "kept" }],
      targets: [{ desired: "running", futureTargetField: { nested: true } }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a state file written by a newer or an older rigd is refused unread with both versions named", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-state-version-"));
  try {
    await mkdir(join(root, "runtime"));
    const path = join(root, "runtime", "state.json");
    const store = new FileStateStore(root);
    await writeFile(path, JSON.stringify({ version: 6, ...inventory }));
    await expect(store.read()).rejects.toMatchObject({
      code: "STATE_VERSION",
      hint: expect.stringMatching(/version 6.*version 5/s),
      details: { path, version: 6, supported: 5 },
    });
    expect(await readFile(path, "utf8")).toContain('"version":6');
    for (const version of [1, 2, 3]) {
      const old = JSON.stringify({ version, ...inventory });
      await writeFile(path, old);
      await expect(store.read()).rejects.toMatchObject({
        code: "STATE_VERSION",
        message: expect.stringContaining("an older rigd"),
        details: { path, version, supported: 5 },
      });
      await expect(store.update(() => {})).rejects.toMatchObject({
        code: "STATE_VERSION",
      });
      expect(await readFile(path, "utf8")).toBe(old);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plan an older Rig recorded under launchd supervision is read as rigd's and saved so, and an exit launchd witnessed is still read and described", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-state-launchd-plan-"));
  try {
    await mkdir(join(root, "runtime"));
    const path = join(root, "runtime", "state.json");
    const recorded = structuredClone(inventory);
    const target = recorded.targets[0]!;
    target.plan.providers.processSupervisor = "launchd";
    Object.assign(target, {
      recovery: {
        plan: structuredClone(target.plan),
        desired: "stopped",
        stage: "pending",
      },
      services: {
        web: {
          deployment: "/tmp/demo",
          intent: "stopped",
          attempts: [],
          outcome: {
            kind: "exited",
            signal: "SIGTERM",
            recordedBy: "launchd",
            at: "2026-09-27T04:00:00.000Z",
          },
        },
      },
    });
    await writeFile(path, JSON.stringify({ version: 5, ...recorded }));
    const store = new FileStateStore(root);
    const read = (await store.read()).targets[0]!;
    expect(read.plan.providers.processSupervisor).toBe("rigd");
    expect(read.recovery!.plan.providers.processSupervisor).toBe("rigd");
    const outcome = read.services!.web!.outcome!;
    expect(outcome).toMatchObject({ kind: "exited", recordedBy: "launchd" });
    expect(describeExit(outcome as Parameters<typeof describeExit>[0])).toBe(
      "was ended by SIGTERM (from launchd's record of its job)",
    );
    await store.update(() => {});
    expect(
      JSON.parse(await readFile(path, "utf8")).targets[0].plan.providers,
    ).toEqual({ processSupervisor: "rigd" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plan an older Rig recorded with ongoing health checks is read without them and saved so", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-state-health-plan-"));
  try {
    await mkdir(join(root, "runtime"));
    const path = join(root, "runtime", "state.json");
    const recorded = structuredClone(inventory);
    const target = recorded.targets[0]!;
    (target.plan.components as unknown[]).push({
      name: "web",
      kind: "managed",
      env: {},
      dependsOn: [],
      command: "serve",
      health: "http://127.0.0.1:3000/health",
      readyTimeout: 30,
      healthMonitor: {
        interval: 30,
        timeout: 5,
        failures: 3,
        onFailure: "restart",
      },
    });
    Object.assign(target, {
      recovery: {
        plan: structuredClone(target.plan),
        desired: "stopped",
        stage: "pending",
      },
      services: {
        web: {
          deployment: "/tmp/demo",
          intent: "running",
          attempts: [],
          healthRestarts: { since: 1, at: [2] },
        },
      },
    });
    await writeFile(path, JSON.stringify({ version: 5, ...recorded }));
    const store = new FileStateStore(root);
    const read = (await store.read()).targets[0]!;
    for (const plan of [read.plan, read.recovery!.plan])
      for (const component of plan.components)
        expect(component).not.toHaveProperty("healthMonitor");
    expect(read.plan.components[0]).toMatchObject({
      health: "http://127.0.0.1:3000/health",
      readyTimeout: 30,
    });
    expect(read.services!.web).not.toHaveProperty("healthRestarts");
    await store.update(() => {});
    const saved = await readFile(path, "utf8");
    expect(saved).not.toContain("healthMonitor");
    expect(saved).not.toContain("healthRestarts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plan recorded while environment was called env names its command inputs by the new path when read, so it equals today's plan and is saved so", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-state-environment-sources-"));
  try {
    await mkdir(join(root, "runtime"));
    const path = join(root, "runtime", "state.json");
    const config = parseProjectConfig({
      name: "demo",
      build: "make ${environment.MODE}",
      environment: { MODE: "fast" },
      services: {
        web: {
          command: "serve --db ${services.web.environment.DB}",
          environment: { DB: "db://${environment.MODE}" },
          ports: { http: 3000 },
        },
      },
    });
    const plan = resolveTargetPlan(
      {
        config,
        target: "working",
        workspacePath: "/tmp/demo",
        dataRoot: "/tmp/data",
      },
      { operatorHome: "/home/operator", envRoot: "/rig/env" },
    );
    // What a rigd before the rename recorded for the same file, then spelled `env` and `run`.
    const recordedPlan = JSON.parse(
      JSON.stringify(plan)
        .replaceAll('"environment.', '"env.')
        .replaceAll("services.web.environment.", "services.web.env."),
    );
    expect(JSON.stringify(recordedPlan)).toContain('"source":"env.MODE"');
    expect(JSON.stringify(recordedPlan)).toContain(
      '"source":"services.web.env.DB"',
    );
    const recorded = structuredClone(inventory);
    Object.assign(recorded.targets[0]!, {
      plan: recordedPlan,
      recovery: {
        plan: structuredClone(recordedPlan),
        desired: "stopped",
        stage: "pending",
      },
    });
    await writeFile(path, JSON.stringify({ version: 5, ...recorded }));
    const store = new FileStateStore(root);
    const read = (await store.read()).targets[0]!;
    expect(read.plan).toEqual(plan);
    expect(read.recovery!.plan).toEqual(plan);
    await store.update(() => {});
    const saved = await readFile(path, "utf8");
    expect(saved).not.toContain('"env.');
    expect(saved).not.toContain(".env.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state an older Rig wrote with operator alert records loads without them and is saved so", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-state-alerts-"));
  try {
    await mkdir(join(root, "runtime"));
    const path = join(root, "runtime", "state.json");
    const recorded = structuredClone(inventory);
    await writeFile(
      path,
      JSON.stringify({
        version: 5,
        ...recorded,
        // As the rigd that sent operator alerts last saved them.
        alerts: {
          targets: [
            {
              targetId: recorded.targets[0]!.id,
              project: "demo",
              target: "stable",
              since: "2026-09-27T04:00:00.000Z",
              services: [
                {
                  name: "web",
                  reason: "exited with code 1",
                  brief: "exit 1",
                },
              ],
              recover: "rig up stable --project demo",
              alertedAt: "2026-09-27T04:05:00.000Z",
            },
          ],
          notifiedAt: "2026-09-27T04:05:00.000Z",
          retry: { failures: 1, at: "2026-09-27T04:06:00.000Z" },
        },
      }),
    );
    const store = new FileStateStore(root);
    const read = await store.read();
    // Everything else is read as written.
    expect(read as unknown).toEqual({ version: 5, ...recorded });
    await store.update(() => {});
    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty(
      "alerts",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A Target as state version 4 recorded it: the working and stable Targets had the kinds local and live, under the names
 * local and live or whatever rig.yaml renamed them to. */
function version4Target(
  id: string,
  kind: "local" | "live" | "preview",
  name: string,
  plan: Record<string, unknown> = {},
) {
  return {
    id,
    projectId: "p",
    name,
    kind,
    desired: "running",
    createdAt: "now",
    updatedAt: "now",
    logRoot: `/tmp/logs/${id}`,
    plan: {
      project: "demo",
      target: kind,
      workspacePath: "/tmp/demo",
      dataRoot: `/tmp/data/${id}`,
      deploymentName: name,
      branchSlug: name,
      subdomain: name,
      providers: { processSupervisor: "rigd" },
      components: [
        {
          name: "tool",
          kind: "installed",
          env: {},
          dependsOn: [],
          entrypoint: "/tmp/demo/bin/tool",
        },
      ],
      preparedComponents: [],
      ...plan,
    },
  };
}
const version4Project = {
  id: "p",
  name: "demo",
  repoPath: "/tmp/demo",
  configPath: "/tmp/demo/rig.yaml",
  createdAt: "now",
};

test("state version 4 is read with the working and stable Targets named by their role, and the next write saves version 5", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-state-fixed-names-"));
  try {
    await mkdir(join(root, "runtime"));
    const path = join(root, "runtime", "state.json");
    const routed = {
      domain: "dev.demo.test",
      proxy: {
        upstream: "web",
        routes: [{ prefix: "/", service: "web", port: 4100 }],
      },
    };
    const working = version4Target("w", "local", "dev", routed);
    // A transition left open by the old rigd carries its own plan under the old name too.
    Object.assign(working, {
      recovery: {
        plan: structuredClone(working.plan),
        desired: "running",
        stage: "pending",
      },
    });
    const activity = [
      {
        id: "op",
        projectId: "p",
        project: "demo",
        target: "dev",
        action: "up",
        outcome: "started",
        occurredAt: "now",
      },
    ];
    await writeFile(
      path,
      JSON.stringify({
        version: 4,
        projects: [version4Project],
        targets: [
          working,
          version4Target("s", "live", "live"),
          version4Target("v", "preview", "feat-x-1a2b3c4d"),
        ],
        activity,
      }),
    );
    const store = new FileStateStore(root);
    const state = await store.read();
    expect(state.version).toBe(5);
    const [w, s, v] = state.targets;
    for (const [target, role] of [
      [w!, "working"],
      [s!, "stable"],
    ] as const) {
      expect(target).toMatchObject({ kind: role, name: role });
      for (const plan of [target.plan, target.recovery?.plan].filter(Boolean))
        expect(plan).toMatchObject({
          target: role,
          deploymentName: role,
          branchSlug: role,
          subdomain: role,
        });
    }
    // The recorded hostname and routes are what Caddy serves under the Target's id; the next plan replaces them.
    expect(w!.plan).toMatchObject(routed);
    expect(w!.recovery!.plan).toMatchObject(routed);
    // A Tool published as tool-dev already has the name the working Target publishes now.
    expect(w!.plan.components[0]).not.toHaveProperty("publishedAs");
    expect(v).toMatchObject({
      kind: "preview",
      name: "feat-x-1a2b3c4d",
      plan: { target: "preview", deploymentName: "feat-x-1a2b3c4d" },
    });
    // Activity keeps the names it recorded.
    expect(state.activity as unknown).toEqual(activity);
    await store.update(() => {});
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.version).toBe(5);
    expect(
      saved.targets.map((t: { kind: string; name: string }) => [
        t.kind,
        t.name,
      ]),
    ).toEqual([
      ["working", "working"],
      ["stable", "stable"],
      ["preview", "feat-x-1a2b3c4d"],
    ]);
    // Read again as version 5, nothing changes further.
    expect(await new FileStateStore(root).read()).toEqual(state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a version 4 working Target named local keeps its Tools' published name, so the next plan can retire them", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-state-published-as-"));
  try {
    await mkdir(join(root, "runtime"));
    const path = join(root, "runtime", "state.json");
    const working = version4Target("w", "local", "local");
    working.plan.components.push({
      name: "other",
      kind: "installed",
      env: {},
      dependsOn: [],
      entrypoint: "/tmp/demo/bin/other",
      installName: "renamed",
    } as (typeof working.plan.components)[number]);
    Object.assign(working, {
      recovery: {
        plan: structuredClone(working.plan),
        desired: "stopped",
        stage: "committing",
      },
    });
    await writeFile(
      path,
      JSON.stringify({
        version: 4,
        projects: [version4Project],
        targets: [working, version4Target("s", "live", "live")],
        activity: [],
      }),
    );
    const [w, s] = (await new FileStateStore(root).read()).targets;
    for (const plan of [w!.plan, w!.recovery!.plan])
      expect(plan.components).toMatchObject([
        { name: "tool", publishedAs: "tool-local" },
        { name: "other", installName: "renamed", publishedAs: "renamed-local" },
      ]);
    // The stable Target always published the plain name, which it still does.
    expect(s!.plan.components[0]).not.toHaveProperty("publishedAs");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version 4 names that would collide are made unique: role Targets take their role's name, and a Preview holding one is renamed", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-state-name-held-"));
  try {
    await mkdir(join(root, "runtime"));
    const path = join(root, "runtime", "state.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 4,
        projects: [version4Project],
        targets: [
          // The working Target was renamed to the name the stable Target has now.
          version4Target("w", "local", "stable"),
          version4Target("s", "live", "live"),
          version4Target("v", "preview", "working"),
        ],
        activity: [],
      }),
    );
    const store = new FileStateStore(root);
    const [w, s, v] = (await store.read()).targets;
    expect(w).toMatchObject({
      kind: "working",
      name: "working",
      plan: { target: "working", deploymentName: "working" },
    });
    // Its Tool kept the file it was published as.
    expect(w!.plan.components[0]).toMatchObject({ publishedAs: "tool-stable" });
    expect(s).toMatchObject({
      kind: "stable",
      name: "stable",
      plan: { target: "stable", deploymentName: "stable" },
    });
    expect(v).toMatchObject({
      kind: "preview",
      name: "working-preview",
      plan: {
        target: "preview",
        deploymentName: "working-preview",
        branchSlug: "working-preview",
        subdomain: "working-preview",
      },
    });
    expect(v!.plan.components[0]).toMatchObject({
      publishedAs: "tool-working",
    });
    // The state is valid as read, and saves so.
    await store.update(() => {});
    expect(
      JSON.parse(await readFile(path, "utf8")).targets.map(
        (t: { name: string }) => t.name,
      ),
    ).toEqual(["working", "stable", "working-preview"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a version 4 Preview named dev is renamed, with a number when that name is taken too, and keeps its <tool>-dev file", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-state-preview-dev-"));
  try {
    await mkdir(join(root, "runtime"));
    const path = join(root, "runtime", "state.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 4,
        projects: [version4Project],
        targets: [
          version4Target("w", "local", "local"),
          version4Target("v", "preview", "dev"),
          version4Target("t", "preview", "dev-preview"),
        ],
        activity: [],
      }),
    );
    const [w, v, t] = (await new FileStateStore(root).read()).targets;
    expect(w).toMatchObject({ kind: "working", name: "working" });
    expect(v).toMatchObject({
      kind: "preview",
      name: "dev-preview-2",
      plan: { deploymentName: "dev-preview-2" },
    });
    expect(v!.plan.components[0]).toMatchObject({ publishedAs: "tool-dev" });
    // A Preview whose name was never reserved is left as it was.
    expect(t).toMatchObject({ name: "dev-preview" });
    expect(t!.plan.components[0]).not.toHaveProperty("publishedAs");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

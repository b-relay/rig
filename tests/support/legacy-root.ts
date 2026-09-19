import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from "./rig-fixture";

/** One retired-format Rig root, shaped like what the last JSON-config runtime (origin/main 28ccaed) left behind after
 * `rig init`, `rig up local`, `rig down local`, `rig deploy live` and `rig down live` under an isolated RIG_ROOT: state
 * version 3, saved plans with `envFile`, `hooks`, installed `build`/`buildTimeout`, and per-Target data. Everything
 * lives under the fixture's temporary directory. */
export interface LegacyRootOptions {
  /** The `demo` Project's `web` hooks; its saved plans carry the same. */
  hooks?: Record<string, string>;
  /** Changes applied to the state document before it is written. */
  state?: (state: LegacyState) => void;
}
export interface LegacyState {
  version: number;
  projects: Record<string, unknown>[];
  targets: (Record<string, unknown> & {
    id: string;
    name: string;
    desired: string;
    plan: Record<string, unknown> & { components: Record<string, unknown>[] };
  })[];
  activity: unknown[];
}
export const DEMO = "6207c8ee-d798-47af-a9ae-8ea18785c73d",
  DEMO_LOCAL = "f03270e1-a35b-4fbe-ad40-6d9a1e0fd423",
  DEMO_LIVE = "3c9314ed-6c84-4ca5-83d8-46f925f78b6c",
  PLAIN = "0b0e3c55-51a2-4f0e-9d2f-5d5a5b0c7e11",
  PLAIN_LIVE = "7a1d2f7c-8a4b-4f7e-b6cb-0f1f4d2e9a22",
  REVISION = "2f66b2ed-0450-476c-9392-57281b34371c";
const SERVER = `const port = Number(process.env.PORT);
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: () =>
    new Response(
      [process.env.GREETING, process.env.FROM_FILE, process.env.SHARED].join(" "),
    ),
});
`;

export async function legacyRoot(options: LegacyRootOptions = {}) {
  const fixture = await rigFixture(),
    { base, root } = fixture,
    hooks = options.hooks ?? { preStart: "echo compiled > built.txt" },
    demoRepo = fixture.canonicalRepo,
    plainRepo = join(fixture.canonicalRepo, "..", "plain"),
    targetRoot = (project: string, target: string) =>
      join(root, "targets", project, target),
    demoConfig = {
      name: "demo",
      hookTimeout: 30,
      installTimeout: 300,
      components: {
        web: {
          mode: "managed",
          command: "bun server.js",
          port: 47411,
          health: "http://127.0.0.1:${web.port}/",
          readyTimeout: 20,
          env: { PORT: "${web.port}", GREETING: "hello" },
          envFile: "app.env",
          hooks,
        },
        store: { uses: "sqlite" },
        "demo-tool": {
          mode: "installed",
          entrypoint: "tool.sh",
          build: "chmod +x tool.sh",
          buildTimeout: 90,
        },
      },
      live: { deployBranch: "main", components: { web: { port: 47412 } } },
    },
    plainConfig = {
      name: "plain",
      components: {
        web: {
          mode: "managed",
          command: "bun server.js",
          port: 47421,
          health: "http://127.0.0.1:${web.port}/",
          readyTimeout: 20,
          env: { PORT: "${web.port}", GREETING: "plain" },
        },
      },
      live: {
        deployBranch: "main",
        env: { SHARED: "from-lane" },
        daemon: { keepAlive: false },
      },
    };
  const writeRepo = async (path: string, config: unknown) => {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "server.js"), SERVER);
    await writeFile(join(path, "app.env"), "FROM_FILE=file-secret\n");
    await writeFile(join(path, "tool.sh"), "#!/bin/sh\necho demo-tool\n");
    await chmod(join(path, "tool.sh"), 0o755);
    await writeFile(
      join(path, "rig.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    );
  };
  const commitIn = async (path: string) => {
    const git = async (args: string[]) => {
      const result = await fixture.run(["git", ...args], path);
      if (result.code)
        throw new Error(`git ${args[0]} failed: ${result.stderr}`);
      return result.stdout.trim();
    };
    await git(["init", "-q", "-b", "main"]);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Rig Test",
      "-c",
      "user.email=rig-test@example.test",
      "commit",
      "-qm",
      "legacy",
    ]);
    return await git(["rev-parse", "HEAD"]);
  };
  await writeRepo(demoRepo, demoConfig);
  await writeRepo(plainRepo, plainConfig);
  const demoCommit = await commitIn(demoRepo),
    plainCommit = await commitIn(plainRepo);
  // Deployed workspaces: what the old runtime checked out, plus what its hook wrote there.
  const demoWorkspace = join(
      targetRoot(DEMO, DEMO_LIVE),
      "revisions",
      REVISION,
    ),
    plainWorkspace = join(targetRoot(PLAIN, PLAIN_LIVE), "revisions", REVISION);
  await writeRepo(demoWorkspace, demoConfig);
  await writeRepo(plainWorkspace, plainConfig);
  const sentinels: string[] = [];
  for (const directory of [
    targetRoot(DEMO, DEMO_LOCAL),
    targetRoot(DEMO, DEMO_LIVE),
    targetRoot(PLAIN, PLAIN_LIVE),
  ]) {
    await mkdir(join(directory, "data", "sqlite"), { recursive: true });
    await mkdir(join(directory, "logs"), { recursive: true });
    const sentinel = join(directory, "data", "sentinel.txt");
    await writeFile(sentinel, `kept ${directory}\n`);
    sentinels.push(sentinel);
  }
  const web = (port: number, greeting: string) => ({
    name: "web",
    env: { PORT: String(port), GREETING: greeting },
    dependsOn: [],
    kind: "managed",
    port,
    command: "bun server.js",
    readyTimeout: 20,
    health: `http://127.0.0.1:${port}/`,
  });
  const demoPlan = (target: "local" | "live", id: string, port: number) => {
    const workspace = target === "local" ? demoRepo : demoWorkspace,
      store = join(targetRoot(DEMO, id), "data", "sqlite", "store.sqlite");
    return {
      project: "demo",
      target,
      workspacePath: workspace,
      dataRoot: join(targetRoot(DEMO, id), "data"),
      deploymentName: target,
      branchSlug: target,
      subdomain: target,
      ...(target === "live" ? { branch: "main", commit: demoCommit } : {}),
      providerProfile: "default",
      providers: { processSupervisor: "rigd" },
      components: [
        {
          ...web(port, "hello"),
          ...(Object.keys(hooks).length ? { hooks } : {}),
          envFile: join(workspace, "app.env"),
        },
        {
          name: "store",
          env: {},
          dependsOn: [],
          kind: "persistent",
          uses: "sqlite",
          path: store,
        },
        {
          name: "demo-tool",
          env: {},
          dependsOn: [],
          kind: "installed",
          entrypoint: join(workspace, "tool.sh"),
          build: "chmod +x tool.sh",
          buildTimeout: 90,
        },
      ],
      preparedComponents: [{ name: "store", uses: "sqlite", path: store }],
      hookTimeout: 30,
      installTimeout: 300,
    };
  };
  const record = (
    project: string,
    id: string,
    kind: "local" | "live",
    plan: Record<string, unknown> & { components: Record<string, unknown>[] },
    commit?: string,
  ) => ({
    id,
    projectId: project,
    name: kind,
    kind,
    ...(commit ? { branch: "main", commit } : {}),
    plan,
    desired: "stopped",
    createdAt: "2026-09-17T11:53:30.937Z",
    updatedAt: "2026-09-17T11:53:43.864Z",
    logRoot: join(targetRoot(project, id), "logs"),
    ...(commit
      ? { sourceRoot: join(targetRoot(project, id), "revisions") }
      : {}),
  });
  const state: LegacyState = {
    version: 3,
    projects: [
      {
        id: DEMO,
        name: "demo",
        repoPath: demoRepo,
        configPath: join(demoRepo, "rig.json"),
        createdAt: "2026-09-17T11:53:17.118Z",
      },
      {
        id: PLAIN,
        name: "plain",
        repoPath: plainRepo,
        configPath: join(plainRepo, "rig.json"),
        createdAt: "2026-09-17T11:53:18.118Z",
      },
    ],
    targets: [
      record(DEMO, DEMO_LOCAL, "local", demoPlan("local", DEMO_LOCAL, 47411)),
      record(
        DEMO,
        DEMO_LIVE,
        "live",
        demoPlan("live", DEMO_LIVE, 47412),
        demoCommit,
      ),
      record(
        PLAIN,
        PLAIN_LIVE,
        "live",
        {
          project: "plain",
          target: "live",
          workspacePath: plainWorkspace,
          dataRoot: join(targetRoot(PLAIN, PLAIN_LIVE), "data"),
          deploymentName: "live",
          branchSlug: "live",
          subdomain: "live",
          branch: "main",
          commit: plainCommit,
          providerProfile: "default",
          providers: { processSupervisor: "rigd" },
          env: { SHARED: "from-lane" },
          daemon: { keepAlive: false },
          components: [web(47421, "plain")],
          preparedComponents: [],
        },
        plainCommit,
      ),
    ],
    activity: [
      {
        id: "7c3d038a-c93e-47b0-be24-f9a58d67ee61",
        projectId: DEMO,
        project: "demo",
        action: "init",
        outcome: "registered",
        occurredAt: "2026-09-17T11:53:17.124Z",
      },
    ],
  };
  options.state?.(state);
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(
    join(root, "runtime", "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  );
  await mkdir(join(root, "installed", "owners"), { recursive: true });
  await writeFile(
    join(
      root,
      "installed",
      "owners",
      "90a022f4756c495275c099950ca616562b51d54b1f358be283c3124cbee4ff20.json",
    ),
    JSON.stringify({
      targetId: DEMO_LIVE,
      componentName: "demo-tool",
      project: "demo",
      target: "live",
      revision:
        "0191c5d0ceb0134ff1836335eb7533b5251ca13ccb5fbd22ab3069d6bcec15d3",
    }),
  );
  const cutover = (args: string[]) =>
    fixture.run(
      [
        process.execPath,
        join(import.meta.dir, "../../src/cutover.ts"),
        ...args,
      ],
      base,
    );
  return {
    ...fixture,
    /** For tests that started no daemon and no process. */
    remove: () => rm(base, { recursive: true, force: true }),
    cutover,
    demoRepo,
    plainRepo,
    demoCommit,
    plainCommit,
    sentinels,
    statePath: join(root, "runtime", "state.json"),
  };
}

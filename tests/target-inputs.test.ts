import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTargetEffects } from "../src/adapters/target-effects";
import { resolveTargetPlan } from "../src/config";
import type { InstalledComponent, ManagedComponent } from "../src/config/types";
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import { runCommand } from "../src/providers/command-runner";
import type { CommandRunner } from "../src/providers/contracts";
import type { TargetRecord } from "../src/domain/runtime";
import { RigError } from "../src/domain/errors";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const SECRET = "s3cret value";
/** An isolated Rig root, operator home and Working copy whose run command reaches a Project env leaf through a Service env leaf. */
async function selected(
  operatorFile: string,
  config: Record<string, unknown> = {
    name: "app",
    env: { DB_NAME: "app" },
    services: {
      api: {
        run: "./serve.sh --db ${services.api.env.DATABASE_URL}",
        ports: { http: "auto" },
        env: { DATABASE_URL: "db://${env.DB_NAME}/main" },
      },
    },
  },
  target: "local" | "live" = "local",
) {
  const base = await mkdtemp(join(tmpdir(), "rig-inputs-"));
  roots.push(base);
  const root = join(base, "rig"),
    home = join(base, "home"),
    workspace = join(base, "app");
  await mkdir(join(root, "env", "app"), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(root, "env", "app", "working.env"), operatorFile, {
    mode: 0o600,
  });
  // An ordinary executable: it knows its own argv and env names, nothing about Rig.
  await writeFile(
    join(workspace, "serve.sh"),
    [
      "#!/bin/sh",
      '[ "$1" = "--db" ] && [ "$2" = "db://app/main" ] || exit 11',
      '[ "$DATABASE_URL" = "db://app/main" ] && [ "$DB_NAME" = "app" ] || exit 12',
      `[ "$API_TOKEN" = "${SECRET}" ] || exit 13`,
      '[ -z "$RIG_ROOT" ] && [ -z "$AMBIENT_ONLY" ] || exit 14',
      "echo pass",
      "",
    ].join("\n"),
  );
  await chmod(join(workspace, "serve.sh"), 0o755);
  const plan = resolveTargetPlan(
    {
      config: config as never,
      target,
      workspacePath: workspace,
      dataRoot: join(root, "data"),
      assignedPorts: { api: 4100, worker: 4101 },
    },
    { operatorHome: home, envRoot: join(root, "env") },
  );
  const record: TargetRecord = {
    id: "t",
    projectId: "p",
    name: target,
    kind: target,
    desired: "running",
    createdAt: "now",
    updatedAt: "now",
    logRoot: join(root, "logs"),
    plan,
  };
  const invocations: string[][] = [];
  const run: CommandRunner = (request) => {
    invocations.push([...request.command]);
    return runCommand(request);
  };
  const adapter = createTargetEffects({
    root,
    recordingTime: () => "now",
    supervisors: new Map(),
    run,
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router: {
      async apply() {},
      async remove() {},
      async checkpoint(key) {
        return { key, value: null };
      },
      async restore() {},
    },
    environment: { PATH: process.env.PATH!, HOME: home },
  });
  const api = plan.components.find(
    (component) => component.name === "api",
  ) as ManagedComponent;
  const logged = async () =>
    (
      await readFile(join(record.logRoot, "target.jsonl"), "utf8").catch(
        () => "",
      )
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { line: string }).line);
  return {
    adapter,
    record,
    api,
    plan,
    root,
    home,
    workspace,
    invocations,
    logged,
  };
}

test("an env file that changes a public value the run command reaches indirectly is refused by key and sources before anything runs", async () => {
  const { adapter, record, api, invocations } = await selected(
    `DB_NAME=other-${SECRET}\n`,
  );
  const failure = await adapter
    .environment(record, api)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RigError);
  const error = failure as RigError;
  expect(error.code).toBe("ENV_CONFLICT");
  expect(error.details).toEqual({
    key: "DB_NAME",
    component: "api",
    sources: [
      "env.DB_NAME",
      join(record.plan.dataRoot, "..", "env", "app", "working.env"),
    ],
  });
  expect(
    JSON.stringify([error.message, error.hint, error.details]),
  ).not.toContain(SECRET);
  expect(invocations.filter(([program]) => program === "/bin/sh")).toEqual([]);
});

test("an equal file value is no conflict, and the resolved invocation runs an ordinary executable with exactly its declared inputs", async () => {
  const { adapter, record, api, plan, workspace } = await selected(
    `DB_NAME=app\nAPI_TOKEN="${SECRET}"\n`,
  );
  expect(api.command).toBe("./serve.sh --db db://app/main");
  const env = await adapter.environment(record, api);
  const result = await runCommand({
    command: ["/bin/sh", "-c", api.command],
    cwd: workspace,
    env,
    timeoutMs: 5000,
  });
  expect([result.exitCode, result.stdout]).toEqual([0, "pass\n"]);
  // The same executable runs with the same inputs supplied by hand.
  const manual = await runCommand({
    command: ["./serve.sh", "--db", "db://app/main"],
    cwd: workspace,
    env: {
      PATH: process.env.PATH!,
      DATABASE_URL: "db://app/main",
      DB_NAME: "app",
      API_TOKEN: SECRET,
    },
    timeoutMs: 5000,
  });
  expect(manual.stdout).toBe("pass\n");
  expect(JSON.stringify(plan)).not.toContain(SECRET);
});

const LAYERS = {
  name: "app",
  env: {
    A: "project",
    B: "project",
    C: "project",
    D: "project",
    E: "project",
    F: "project",
    G: "project",
  },
  env_file: ["env/project-1.env", "~/project-2.env"],
  services: {
    api: {
      run: "api",
      ports: { http: "auto" },
      env: {
        B: "service",
        C: "service",
        D: "service",
        E: "service",
        F: "service",
        G: "service",
      },
      env_file: "env/api.env",
    },
    worker: {
      run: "worker",
      ports: { http: "auto" },
      env_file: "env/worker.env",
    },
  },
  tools: { ctl: { bin: "ctl" } },
};
async function layered(target: "local" | "live" = "local") {
  const role = target === "local" ? "working" : "stable";
  const s = await selected("G=project-role\n", LAYERS, target);
  const write = async (path: string, text: string) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text, { mode: 0o600 });
  };
  await write(
    join(s.workspace, "env", "project-1.env"),
    "C=file-1\nD=file-1\nE=file-1\nF=file-1\nG=file-1\n",
  );
  await write(
    join(s.home, "project-2.env"),
    "D=file-2\nE=file-2\nF=file-2\nG=file-2\n",
  );
  await write(
    join(s.root, "env", "app", "all.env"),
    "E=project-all\nF=project-all\nG=project-all\n",
  );
  await write(
    join(s.root, "env", "app", `${role}.env`),
    "F=project-role\nG=project-role\n",
  );
  await write(
    join(s.workspace, "env", "api.env"),
    "G=api-file\nH=api-file\nI=api-file\n",
  );
  await write(
    join(s.root, "env", "app", "api", "all.env"),
    "H=api-all\nI=api-all\n",
  );
  await write(join(s.root, "env", "app", "api", `${role}.env`), "I=api-role\n");
  await write(join(s.workspace, "env", "worker.env"), "WORKER_ONLY=1\n");
  return s;
}

test("each invocation composes its own scope, lowest to highest: Project env, Service env, Project files, Project operator files, Service files, Service operator files", async () => {
  const { adapter, record, api, plan, root, home } = await layered();
  const env = await adapter.environment(record, api);
  expect(env).toEqual({
    PATH: process.env.PATH!,
    HOME: home,
    TMPDIR: join(root, "tmp", "t"),
    A: "project",
    B: "service",
    C: "file-1",
    D: "file-2",
    E: "project-all",
    F: "project-role",
    G: "api-file",
    H: "api-all",
    I: "api-role",
  });
  expect((await stat(env.TMPDIR!)).mode & 0o777).toBe(0o700);
  // A sibling Service and a Tool never see the api Service's files or env.
  const worker = plan.components.find(
    (c) => c.name === "worker",
  ) as ManagedComponent;
  expect(await adapter.environment(record, worker)).toMatchObject({
    B: "project",
    G: "project-role",
    WORKER_ONLY: "1",
  });
  expect((await adapter.environment(record, worker)).H).toBeUndefined();
  const ctl = plan.components.find(
    (c) => c.name === "ctl",
  ) as InstalledComponent;
  const scoped = await adapter.environment(record, ctl);
  expect([scoped.B, scoped.G, scoped.H, scoped.WORKER_ONLY]).toEqual([
    "project",
    "project-role",
    undefined as never,
    undefined as never,
  ]);
});

test("role files follow the Target's role, not its display name, and a fresh file is read on the next invocation without touching the plan", async () => {
  const { adapter, record, api, root, plan } = await layered("live");
  expect((await adapter.environment(record, api)).I).toBe("api-role");
  const before = JSON.stringify(plan);
  await writeFile(
    join(root, "env", "app", "api", "stable.env"),
    "I=rotated\n",
    {
      mode: 0o600,
    },
  );
  expect((await adapter.environment(record, api)).I).toBe("rotated");
  expect(JSON.stringify(record.plan)).toBe(before);
  expect(before).not.toContain("api-role");
});

test("a listed file that is missing fails safely, an absent operator convention file is skipped, and nothing advises committing it", async () => {
  const { adapter, record, api, workspace } = await selected("", {
    name: "app",
    services: {
      api: { run: "api", ports: { http: "auto" }, env_file: "secrets.env" },
    },
  });
  const failure = (await adapter
    .environment(record, api)
    .catch((error: unknown) => error)) as RigError;
  expect(failure.code).toBe("ENV_FILE_MISSING");
  expect(failure.hint).toContain("~/.rig/env/<project>/");
  expect(failure.hint).toContain("Never commit");
  // Once the listed file exists, the absent all.env and per-Service convention files are no failure.
  await writeFile(join(workspace, "secrets.env"), "TOKEN=1\n", { mode: 0o600 });
  expect((await adapter.environment(record, api)).TOKEN).toBe("1");
});

test("an env file inside the repository must be ignored by Git, and one other users can read is warned about once, by path only", async () => {
  const { adapter, record, api, workspace, logged } = await selected("", {
    name: "app",
    services: {
      api: {
        run: "api",
        ports: { http: "auto" },
        ready: "true",
        env_file: ".env",
      },
    },
  });
  const git = (...args: string[]) =>
    runCommand({
      command: ["git", ...args],
      cwd: workspace,
      env: { PATH: process.env.PATH! },
      timeoutMs: 10_000,
    });
  await git("init", "-q");
  await writeFile(join(workspace, ".env"), `TOKEN=${SECRET}\n`, {
    mode: 0o644,
  });
  const refused = (await adapter
    .environment(record, api)
    .catch((error: unknown) => error)) as RigError;
  expect(refused).toMatchObject({
    code: "ENV_FILE_TRACKED",
    details: { path: join(workspace, ".env") },
  });
  expect(JSON.stringify([refused.message, refused.hint])).not.toContain(SECRET);
  expect(refused.hint).toContain(".gitignore");
  await writeFile(join(workspace, ".gitignore"), ".env\n");
  expect((await adapter.environment(record, api)).TOKEN).toBe(SECRET);
  await adapter.environment(record, api);
  expect(await logged()).toEqual([
    `Environment file ${join(workspace, ".env")} is accessible to other users (mode 644); run chmod 600 on it.`,
  ]);
});

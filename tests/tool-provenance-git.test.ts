import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTargetEffects } from "../src/adapters/target-effects";
import type { InstalledComponent } from "../src/config/types";
import type { TargetRecord } from "../src/domain/runtime";
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import { runCommand } from "../src/providers/command-runner";
import type { Supervisor } from "../src/providers/contracts";
import { createGitSourceStore } from "../src/providers/git-source-store";
import { localActivation } from "./support/activation-doubles";
import { noRoutes } from "./support/router-doubles";

// Rig's own rigd, once its owner is gone, goes only to a checkout of the repository that published it (#343), identified by
// its root commits. A shallow clone reports where its history was cut as roots, so it cannot prove which repository it is:
// it is refused as shallow, never as another repository, and never records provenance. Real git, Rig's real source store.

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const rigd: InstalledComponent = {
  name: "rigd",
  kind: "installed",
  entrypoint: "rigd",
  env: {},
  dependsOn: [],
};

async function git(cwd: string | undefined, ...args: string[]) {
  const result = await runCommand({
    command: [
      "git",
      "-c",
      "user.name=Rig Test",
      "-c",
      "user.email=rig@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    ...(cwd ? { cwd } : {}),
    env: { PATH: process.env.PATH!, HOME: tmpdir() },
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function world() {
  const base = await mkdtemp(join(tmpdir(), "rig-provenance-git-"));
  roots.push(base);
  const rigRoot = join(base, "rig-root");
  // Rig's repository, with a history: three commits, each a rigd that prints its version.
  const origin = join(base, "origin");
  await git(undefined, "init", "-q", origin);
  for (const version of ["v1", "v2", "v3"]) {
    await writeFile(join(origin, "rigd"), `#!/bin/sh\necho rigd ${version}\n`);
    await chmod(join(origin, "rigd"), 0o755);
    await git(origin, "add", "rigd");
    await git(origin, "commit", "-q", "-m", version);
  }
  // A second branch, so a clone that keeps every branch has more than one shallow boundary.
  await git(origin, "checkout", "-q", "-b", "other");
  await writeFile(join(origin, "notes"), "other\n");
  await git(origin, "add", "notes");
  await git(origin, "commit", "-q", "-m", "other");
  await git(origin, "checkout", "-q", "main");
  const sources = createGitSourceStore({
    root: join(rigRoot, "sources"),
    run: runCommand,
  });
  let recorded = new Set<string>();
  /** Each Project's registered repository, as state records it. */
  const registered = new Map<string, string>();
  const effects = createTargetEffects({
    ...localActivation(),
    root: rigRoot,
    recordingTime: () => "2026-10-11T12:00:00.000Z",
    supervisors: new Map([["child", {} as Supervisor]]),
    run: runCommand,
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router: noRoutes(),
    environment: { PATH: process.env.PATH!, HOME: tmpdir() },
    recordedTargets: async () => recorded,
    projectRepository: async (projectId) => registered.get(projectId),
  });
  const daemon = join(rigRoot, "bin", "rigd");
  let checkout = 0;
  return {
    base,
    origin,
    daemon,
    /** Only `ids` are recorded Targets now. */
    record(...ids: string[]) {
      recorded = new Set(ids);
    },
    /** What Rig recorded as the repository that published bin/rigd, if anything. */
    async provenance(): Promise<string | undefined> {
      const owners = join(rigRoot, "installed", "owners");
      const hash = createHash("sha256").update(daemon).digest("hex");
      const text = await readFile(
        join(owners, `${hash}.repository.json`),
        "utf8",
      ).catch(() => undefined);
      return text === undefined ? undefined : JSON.parse(text).repository;
    },
    /** Deploys `repository`'s main as the stable Target `id` of Project `project`, registered at `repository` (or at
     * `registeredAt`): a fresh checkout from Rig's mirror, then the checkpointed install of rigd, committed. */
    async deploy(
      id: string,
      project: string,
      repository: string,
      registeredAt = repository,
    ) {
      registered.set(project, registeredAt);
      const { workspacePath, commit } = await sources.prepare({
        project,
        repository,
        ref: "main",
        destination: join(rigRoot, "targets", id, `checkout-${++checkout}`),
      });
      const target: TargetRecord = {
        id,
        projectId: project,
        name: "stable",
        kind: "stable",
        desired: "stopped",
        createdAt: "now",
        updatedAt: "now",
        logRoot: join(rigRoot, "logs", id),
        commit,
        plan: {
          project: "rig",
          target: "stable",
          workspacePath,
          dataRoot: join(rigRoot, "data", id),
          deploymentName: "stable",
          branchSlug: "main",
          subdomain: "rig",
          providers: { processSupervisor: "child" },
          components: [rigd],
          preparedComponents: [],
        },
      };
      const checkpoint = await effects.checkpoint(target);
      try {
        await effects.install(rigd, target);
      } catch (error) {
        await checkpoint.rollback();
        throw error;
      }
      await checkpoint.commit();
    },
  };
}

test("a released rigd goes to a full clone of the repository that published it; a shallow clone is refused as shallow until it is unshallowed", async () => {
  const w = await world();
  const history = await git(w.origin, "rev-list", "--max-parents=0", "HEAD");
  // Published from the full repository, which records its root commit.
  w.record("first");
  await w.deploy("first", "rig-first", w.origin);
  expect(await w.provenance()).toBe(history);
  const published = await readFile(w.daemon, "utf8");

  // Its Target forgotten; a shallow clone of the same repository asks for it.
  const shallow = join(w.base, "shallow");
  await git(
    undefined,
    "clone",
    "-q",
    "--depth=1",
    `file://${w.origin}`,
    shallow,
  );
  expect(await git(shallow, "rev-parse", "--is-shallow-repository")).toBe(
    "true",
  );
  w.record("second");
  const refused = await w
    .deploy("second", "rig-second", shallow)
    .catch((error: unknown) => error);
  expect(refused).toMatchObject({
    code: "ARTIFACT_CONFLICT",
    details: expect.objectContaining({ reason: "repository-shallow" }),
    message: expect.stringContaining("This checkout is a shallow clone"),
    hint: expect.stringContaining(
      "Run git fetch --unshallow in the Project's repository, then deploy again.",
    ),
  });
  expect(await readFile(w.daemon, "utf8")).toBe(published);
  expect(await w.provenance()).toBe(history);

  // Unshallowed, the same registration's next deploy proves its history and takes rigd over.
  await git(shallow, "fetch", "-q", "--unshallow");
  await w.deploy("second", "rig-second", shallow);
  expect(await readFile(w.daemon, "utf8")).toBe("#!/bin/sh\necho rigd v3\n");
  expect(await w.provenance()).toBe(history);

  // And a full clone, from anywhere, takes it over once that Target is gone too.
  const clone = join(w.base, "clone");
  await git(undefined, "clone", "-q", `file://${w.origin}`, clone);
  w.record("third");
  await w.deploy("third", "rig-third", clone);
  expect(await w.provenance()).toBe(history);
});

test("a recorded Target deploying from a shallow clone still publishes rigd, but records no provenance from it", async () => {
  const w = await world();
  const shallow = join(w.base, "shallow");
  await git(
    undefined,
    "clone",
    "-q",
    "--depth=1",
    `file://${w.origin}`,
    shallow,
  );
  w.record("only");
  await w.deploy("only", "rig", shallow);
  expect(await readFile(w.daemon, "utf8")).toBe("#!/bin/sh\necho rigd v3\n");
  expect(await w.provenance()).toBeUndefined();
  // Once the repository has its whole history, the recorded Target's next deploy records it.
  await git(shallow, "fetch", "-q", "--unshallow");
  await w.deploy("only", "rig", shallow);
  expect(await w.provenance()).toBe(
    await git(w.origin, "rev-list", "--max-parents=0", "HEAD"),
  );
});

test("a takeover is judged by the Project's own repository, not Rig's mirror: an unshallowed clone whose other branch was pruned still proves its history", async () => {
  const w = await world();
  const history = await git(w.origin, "rev-list", "--max-parents=0", "HEAD");
  w.record("first");
  await w.deploy("first", "rig-first", w.origin);
  // A shallow clone that keeps every branch: Rig's mirror of it is cut at each branch's tip.
  const shallow = join(w.base, "shallow");
  await git(
    undefined,
    "clone",
    "-q",
    "--depth=1",
    "--no-single-branch",
    `file://${w.origin}`,
    shallow,
  );
  w.record("second");
  await expect(w.deploy("second", "rig-second", shallow)).rejects.toMatchObject(
    {
      details: expect.objectContaining({ reason: "repository-shallow" }),
    },
  );
  // Unshallowed, then its other branch deleted and its objects collected: the mirror's boundary for that branch stays.
  await git(shallow, "fetch", "-q", "--unshallow");
  await git(shallow, "branch", "-r", "-d", "origin/other");
  await git(shallow, "reflog", "expire", "--expire=now", "--all");
  await git(shallow, "gc", "-q", "--prune=now");
  expect(await git(shallow, "rev-parse", "--is-shallow-repository")).toBe(
    "false",
  );
  await w.deploy("second", "rig-second", shallow);
  expect(await readFile(w.daemon, "utf8")).toBe("#!/bin/sh\necho rigd v3\n");
  expect(await w.provenance()).toBe(history);
});

test("a deployed Commit the Project's registered repository does not hold identifies nothing: repository-unknown", async () => {
  const w = await world();
  w.record("first");
  await w.deploy("first", "rig-first", w.origin);
  const published = await readFile(w.daemon, "utf8");
  // A clone with a Commit of its own, deployed while the Project is registered at the original, which lacks it.
  const clone = join(w.base, "clone");
  await git(undefined, "clone", "-q", `file://${w.origin}`, clone);
  await writeFile(join(clone, "rigd"), "#!/bin/sh\necho rigd v4\n");
  await git(clone, "commit", "-q", "-am", "v4");
  w.record("second");
  await expect(
    w.deploy("second", "rig-second", clone, w.origin),
  ).rejects.toMatchObject({
    code: "ARTIFACT_CONFLICT",
    details: expect.objectContaining({ reason: "repository-unknown" }),
  });
  expect(await readFile(w.daemon, "utf8")).toBe(published);
});

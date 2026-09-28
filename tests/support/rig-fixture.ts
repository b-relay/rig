import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
/** Names come from the root's own record, so renamed Targets and generated Previews are found as well as local and live. */
async function recordedTargets(root: string) {
  try {
    const state = JSON.parse(
      await readFile(join(root, "runtime", "state.json"), "utf8"),
    ) as {
      projects: { id: string; name: string }[];
      targets: { projectId: string; name: string; kind: string }[];
    };
    return state.targets.map((target) => ({
      name: target.name,
      kind: target.kind,
      project: [
        "--project",
        state.projects.find((project) => project.id === target.projectId)
          ?.name ?? "",
      ],
    }));
  } catch {
    return [];
  }
}
/** A command's stderr without the one line every command run in a rig/v1 Project prints. These end-to-end Projects are
 * rig/v1 files, as every rig.yaml written before formats was, so a successful command prints that line and nothing else. */
export function beyondDeprecation(stderr: string): string {
  return stderr.replace(
    /^Deprecated: \S+ is written in rig\.yaml format rig\/v1, which is deprecated\. Run rig config upgrade to rewrite it as rig\/v2, then commit it\.\n/,
    "",
  );
}
/** Runs `rig` and `rigd` from source by default; `commands` substitutes other executables, such as `bun build --compile` output,
 * and `PATH` replaces the PATH they (and the daemon `rigd install` starts) inherit. `HOME` does the same for the home
 * directory, which is where the Services the daemon runs find the operator's caches. */
export async function rigFixture(
  options: {
    readonly commands?: {
      readonly rig: readonly string[];
      readonly rigd: readonly string[];
    };
    readonly PATH?: string;
    readonly HOME?: string;
  } = {},
) {
  const base = await mkdtemp(join(tmpdir(), "rig-battle-")),
    root = join(base, ".rig"),
    repo = join(base, "project");
  await mkdir(repo);
  // A real rigd runs under this root: it must never post a macOS notification to the person running the tests.
  await mkdir(root, { mode: 0o700 });
  await writeFile(
    join(root, "config.yaml"),
    "alerts:\n  channels:\n    macos:\n      enabled: false\n",
  );
  const environment = {
    ...process.env,
    ...(options.PATH === undefined ? {} : { PATH: options.PATH }),
    ...(options.HOME === undefined ? {} : { HOME: options.HOME }),
    RIG_ROOT: root,
  };
  const commands = options.commands ?? {
    rig: [process.execPath, join(import.meta.dir, "../../src/index.ts")],
    rigd: [process.execPath, join(import.meta.dir, "../../src/rigd.ts")],
  };
  const run = async (args: string[], cwd = repo) => {
    const child = Bun.spawn(args, {
      cwd,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  const rig = (args: string[], cwd = repo) =>
    run([...commands.rig, ...args], cwd);
  const rigd = (args: string[]) => run([...commands.rigd, ...args], base);
  const git = async (args: string[]) => {
    const result = await run(["git", ...args]);
    if (result.code) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = async () => {
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Rig Test",
      "-c",
      "user.email=rig-test@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    return await git(["rev-parse", "HEAD"]);
  };
  const cleanup = async () => {
    // Tests stop their own Targets; after a failed assertion, whatever the root records is stopped under its actual name.
    for (const target of await recordedTargets(root))
      await rig(
        target.kind === "preview"
          ? ["down", "preview", "--deployment", target.name, ...target.project]
          : ["down", target.name, ...target.project],
        base,
      ).catch(() => {});
    await rigd(["uninstall"]).catch(() => {});
    await rm(base, { recursive: true, force: true });
  };
  return {
    base,
    root,
    repo,
    run,
    rig,
    rigd,
    git,
    commit,
    cleanup,
    canonicalRepo: await realpath(repo),
  };
}

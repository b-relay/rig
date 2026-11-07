import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand } from "../../src/providers/command-runner";
import { createProcessIdentityReader } from "../../src/providers/process-identity";
import {
  processLeaseRoot,
  processLeaseSchema,
} from "../../src/providers/process-lease";
/** Targets come from the root's own record, so generated Previews are found as well as the working and stable Targets. A
 * root with no record has none; a record that cannot be read is a string saying why. */
async function recordedTargets(root: string) {
  let text: string;
  try {
    text = await readFile(join(root, "runtime", "state.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return `its Targets could not be read (${error}), so none was stopped`;
  }
  try {
    const state = JSON.parse(text) as {
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
  } catch (error) {
    return `its Targets could not be read (${error}), so none was stopped`;
  }
}
/** When the process `pid` started and what it runs, while it is alive: a later process of that pid differs. */
export function processIdentity(pid: number): string | undefined {
  return (
    Bun.spawnSync(
      ["ps", "-p", String(pid), "-o", "lstart=", "-o", "command="],
      { stdout: "pipe", stderr: "ignore" },
    ).stdout.toString() || undefined
  );
}
/** `processIdentity`, while the process is a rigd. */
export function daemonIdentity(pid: number): string | undefined {
  const seen = processIdentity(pid);
  return seen?.includes("rigd") ? seen : undefined;
}
/** The rigd `root` records now, read before an uninstall removes that record, which it does before the process exits. */
export async function recordedDaemon(root: string) {
  const { pid } = (await readFile(join(root, "daemon", "address.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => ({}))) as { pid?: number };
  const identity = pid === undefined ? undefined : daemonIdentity(pid);
  return identity === undefined ? undefined : { pid: pid!, identity };
}
/** The processes `root`'s leases name now, read apart from its Target record, so a Service is found whatever that record
 * holds: every member of each leased process group whose leader is still the process its lease names. A group whose leader
 * is gone cannot be told from a stranger's, so it is only named, never signalled. Read before rig down or rigd uninstall,
 * which remove the leases of what they stop. */
async function leasedProcesses(root: string) {
  const identityOf = createProcessIdentityReader(runCommand);
  const groups = Bun.spawnSync(["ps", "-axo", "pid=,pgid="])
    .stdout.toString()
    .trim()
    .split("\n")
    .map((row) => row.trim().split(/\s+/).map(Number));
  const owned: { pid: number; identity: string }[] = [];
  const leaderless: number[] = [];
  const unreadable: string[] = [];
  // rigd's leases, and those of the capture wrappers it runs, which lease the applications.
  for (const directory of [root, join(root, "capture")].map(processLeaseRoot)) {
    const names = await readdir(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        unreadable.push(directory);
      return [];
    });
    // A lease is replaced through a temporary file beside it, which is not one.
    for (const name of names.filter((name) =>
      /^[0-9a-f]{64}\.json$/.test(name),
    )) {
      const lease = processLeaseSchema.safeParse(
        await readFile(join(directory, name), "utf8")
          .then((text) => JSON.parse(text))
          .catch(() => undefined),
      );
      if (!lease.success) unreadable.push(join(directory, name));
      else if ((await identityOf(lease.data.pid)) !== lease.data.identity)
        leaderless.push(lease.data.pid);
      else
        for (const [pid, pgid] of groups) {
          const identity =
            pgid === lease.data.pid ? processIdentity(pid!) : undefined;
          if (identity !== undefined) owned.push({ pid: pid!, identity });
        }
    }
  }
  return { owned, leaderless, unreadable };
}
/** Signals `owned` while it is still that process; one that has just exited is left alone. */
function signalOwned(
  owned: { pid: number; identity: string },
  signal: NodeJS.Signals,
) {
  if (processIdentity(owned.pid) !== owned.identity) return;
  try {
    process.kill(owned.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
/** Whether process group `group` has a member. */
function groupRuns(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
/** How long a rigd or a Service may take to exit once it has been told to, on a machine as loaded as a test run makes it. */
const PROCESS_EXIT_MS = 15_000;
/** Whether the process `owned` is gone by the deadline; it answers as soon as it is. */
export async function processExited(owned: {
  pid: number;
  identity: string;
}): Promise<boolean> {
  const deadline = Date.now() + PROCESS_EXIT_MS;
  while (processIdentity(owned.pid) === owned.identity) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(20);
  }
  return true;
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
  let removed = false;
  /** Stops what the root records and removes it. When any of that cannot be confirmed, the root is kept, for what it
   * records, and the cleanup fails saying why. Once the root is removed, a further cleanup has nothing to do. */
  const cleanup = async () => {
    if (removed) return;
    const problems: string[] = [];
    const succeeded = async (
      args: string[],
      ran: Promise<{ code: number; stderr: string }>,
    ) => {
      const result = await ran.catch((error: unknown) => ({
        code: -1,
        stderr: String(error),
      }));
      if (result.code !== 0)
        problems.push(
          `${args.join(" ")} exited with ${result.code}: ${result.stderr.trim()}`,
        );
      return result.code === 0;
    };
    // Tests stop their own Targets; after a failed assertion, whatever the root records is stopped by its role or Preview name,
    // through the rigd that serves the root. A test that already stopped its rigd has nothing left that rig down could ask.
    const daemon = await recordedDaemon(root);
    const leased = await leasedProcesses(root);
    for (const path of leased.unreadable)
      problems.push(`the lease ${path} could not be read`);
    const targets = daemon === undefined ? [] : await recordedTargets(root);
    if (typeof targets === "string") problems.push(targets);
    else
      for (const target of targets) {
        const args =
          target.kind === "preview"
            ? [
                "down",
                "preview",
                "--deployment",
                target.name,
                ...target.project,
              ]
            : ["down", target.kind, ...target.project];
        await succeeded(["rig", ...args], rig(args, base));
      }
    const uninstalled = await succeeded(
      ["rigd", "uninstall"],
      rigd(["uninstall"]),
    );
    // A daemon that outlives this would run on with its root deleted, for as long as the machine stays up. One rigd
    // uninstall could not stop is asked to stop here; one that will not is killed.
    if (daemon !== undefined) {
      if (!uninstalled && daemonIdentity(daemon.pid) === daemon.identity)
        process.kill(daemon.pid, "SIGTERM");
      if (!(await processExited(daemon))) {
        process.kill(daemon.pid, "SIGKILL");
        problems.push(
          `rigd ${daemon.pid} did not stop, and was killed${(await processExited(daemon)) ? "" : ", but is still running"}`,
        );
      }
    }
    // What rigd ran and did not stop is stopped here, and the root goes only once it has exited.
    const surviving = leased.owned.filter(
      (owned) => processIdentity(owned.pid) === owned.identity,
    );
    if (surviving.length > 0) {
      for (const owned of surviving) signalOwned(owned, "SIGTERM");
      const stubborn: typeof surviving = [];
      for (const owned of surviving)
        if (!(await processExited(owned))) stubborn.push(owned);
      for (const owned of stubborn) signalOwned(owned, "SIGKILL");
      const running: number[] = [];
      for (const owned of stubborn)
        if (!(await processExited(owned))) running.push(owned.pid);
      problems.push(
        `processes ${surviving.map(({ pid }) => pid).join(", ")} that rigd ran outlived rigd, and were stopped${stubborn.length > 0 ? `; ${stubborn.map(({ pid }) => pid).join(", ")} had to be killed` : ""}${running.length > 0 ? `, but ${running.join(", ")} still run` : ""}`,
      );
    }
    for (const group of leased.leaderless)
      if (groupRuns(group))
        problems.push(
          `process group ${group}, which a lease names, still runs without the leader the lease recorded, so it was not signalled`,
        );
    if (problems.length > 0)
      throw new Error(
        `The fixture could not confirm its cleanup, so its root is kept at ${base}:\n${problems.join("\n")}`,
      );
    await rm(base, { recursive: true, force: true });
    removed = true;
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

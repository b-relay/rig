import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
/** Runs `ps` with `args`: its exit status and what it printed. A test substitutes one to see what cleanup does with what
 * it is told. */
export type Inspect = (args: readonly string[]) => {
  exitCode: number;
  stdout: string;
};
/** `ps` with the locale and zone rigd reads process birth times in, so a birth here is the one its leases digest. */
export const platformInspect: Inspect = (args) => {
  const ran = Bun.spawnSync(["/bin/ps", ...args], {
    stdout: "pipe",
    stderr: "ignore",
    env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" },
  });
  return { exitCode: ran.exitCode, stdout: ran.stdout.toString() };
};
/** When the process `pid` started, while it is alive: with its pid, all that names it, since a process that execs keeps
 * both, and a later process of that pid has another. */
export function processIdentity(
  pid: number,
  inspect: Inspect = platformInspect,
): string | undefined {
  return (
    inspect(["-p", String(pid), "-o", "lstart="]).stdout.trim() || undefined
  );
}
/** `processIdentity`, while the process is a rigd. */
export function daemonIdentity(
  pid: number,
  inspect: Inspect = platformInspect,
): string | undefined {
  // lstart is 24 characters in the C locale; what the process runs follows it.
  const seen = inspect([
    "-p",
    String(pid),
    "-o",
    "lstart=",
    "-o",
    "command=",
  ]).stdout;
  return seen.slice(24).includes("rigd") ? seen.slice(0, 24).trim() : undefined;
}
/** What the process `pid` runs, for a report: never what decides which process it is. */
const commandOf = (pid: number, inspect: Inspect) =>
  inspect(["-p", String(pid), "-o", "command="]).stdout.trim();
/** Every process with its group and birth, read at one instant, so a member and its birth are of the same process;
 * undefined when `ps` failed, which proves nothing about what runs. */
function processTable(inspect: Inspect) {
  const listed = inspect(["-axo", "pid=,pgid=,lstart="]);
  const table = listed.stdout.split("\n").flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    return row
      ? [{ pid: Number(row[1]), pgid: Number(row[2]), birth: row[3]! }]
      : [];
  });
  // The fixture's own process is always in a table that was read.
  return listed.exitCode === 0 && table.length > 0 ? table : undefined;
}
type ProcessTable = NonNullable<ReturnType<typeof processTable>>;
/** The rigd `root` records now, read before an uninstall removes that record, which it does before the process exits. */
export async function recordedDaemon(
  root: string,
  inspect: Inspect = platformInspect,
) {
  const { pid } = (await readFile(join(root, "daemon", "address.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => ({}))) as { pid?: number };
  const identity = pid === undefined ? undefined : daemonIdentity(pid, inspect);
  return identity === undefined ? undefined : { pid: pid!, identity };
}
/** The leases in `root`, read apart from its Target record, so a Service is found whatever that record holds: rigd's, and
 * those of the capture wrappers it runs, which lease the applications. Read before rig down or rigd uninstall, which
 * remove the leases of what they stop. */
async function readLeases(root: string) {
  const leases: { pid: number; identity: string }[] = [];
  const unreadable: string[] = [];
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
      if (lease.success) leases.push(lease.data);
      else unreadable.push(join(directory, name));
    }
  }
  return { leases, unreadable };
}
/** The process group `lease` names, with its leader's birth when, in `table`, its pid is still the process the lease
 * names: the group is the fixture's while that leader runs. */
function leasedGroup(
  lease: { pid: number; identity: string },
  table: ProcessTable,
): { pgid: number; leader?: string } {
  const leader = table.find((row) => row.pid === lease.pid)?.birth;
  return leader !== undefined &&
    createHash("sha256").update(`${lease.pid}:${leader}`).digest("hex") ===
      lease.identity
    ? { pgid: lease.pid, leader }
    : { pgid: lease.pid };
}
/** Adds to `owned` (pid to birth) every member `table` shows of a leased group whose leader is, in it, still the process
 * its lease named: only then is the group provably the fixture's. */
function adoptMembers(
  owned: Map<number, string>,
  groups: readonly { pgid: number; leader?: string }[],
  table: ProcessTable,
) {
  for (const group of groups)
    if (
      group.leader !== undefined &&
      table.some((row) => row.pid === group.pgid && row.birth === group.leader)
    )
      for (const row of table)
        if (row.pgid === group.pgid) owned.set(row.pid, row.birth);
}
/** Signals `owned` while it is still that process; one that has just exited, or whose pid another now has, is left alone. */
function signalOwned(
  owned: { pid: number; identity: string },
  signal: NodeJS.Signals,
  inspect: Inspect,
) {
  if (processIdentity(owned.pid, inspect) !== owned.identity) return;
  try {
    process.kill(owned.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
/** How long a rigd or a Service may take to exit once it has been told to, on a machine as loaded as a test run makes it. */
const PROCESS_EXIT_MS = 15_000;
/** Whether the process `owned` is gone by the deadline; it answers as soon as it is. */
export async function processExited(
  owned: { pid: number; identity: string },
  inspect: Inspect = platformInspect,
): Promise<boolean> {
  const deadline = Date.now() + PROCESS_EXIT_MS;
  while (processIdentity(owned.pid, inspect) === owned.identity) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(20);
  }
  return true;
}
/** The cleanup of every fixture whose cleanup has not yet answered. */
const unfinished = new Set<() => Promise<void>>();
/** Every fixture still being made, which registers its cleanup once it is. */
const starting = new Set<Promise<unknown>>();
/** Set once the tests are done: a body Bun abandoned may still run on, and a fixture it asks for then is refused. */
let closed = false;
/** Why each fixture asked for once the tests were done was refused. */
const refused: string[] = [];
/** Cleans up each fixture a test left unfinished, as Bun leaves one when it times the test out or the test throws before its
 * cleanup, and waits for a cleanup already under way: run once every test is done, so no fixture is still in use. Until
 * none is left, it waits for the fixtures still being made and cleans up what they register. Fails naming each root it
 * had to keep, and each fixture it refused. */
export async function stopAbandonedFixtures() {
  closed = true;
  const failed: string[] = [];
  while (starting.size > 0 || unfinished.size > 0) {
    await Promise.allSettled(starting);
    for (const result of await Promise.allSettled(
      [...unfinished].map((cleanup) => cleanup()),
    ))
      if (result.status === "rejected") failed.push(String(result.reason));
  }
  if (failed.length > 0 || refused.length > 0)
    throw new Error(
      `A test left fixtures unfinished, and their cleanup failed or a fixture was refused:\n${[...failed, ...refused].join("\n")}`,
    );
}
/** `createFixture`, while the tests run. Once they are done, a fixture is refused before anything is made, since nothing
 * would clean it up. */
export async function rigFixture(options: FixtureOptions = {}) {
  if (closed) {
    const reason =
      "A fixture was asked for once the tests were done, by a test Bun had abandoned, and was refused.";
    refused.push(reason);
    throw new Error(reason);
  }
  const made = createFixture(options);
  starting.add(made);
  try {
    return await made;
  } finally {
    starting.delete(made);
  }
}
type FixtureOptions = {
  readonly commands?: {
    readonly rig: readonly string[];
    readonly rigd: readonly string[];
  };
  readonly PATH?: string;
  readonly HOME?: string;
  readonly inspect?: Inspect;
};
/** Runs `rig` and `rigd` from source by default; `commands` substitutes other executables, such as `bun build --compile` output,
 * and `PATH` replaces the PATH they (and the daemon `rigd install` starts) inherit. `HOME` does the same for the home
 * directory, which is where the Services the daemon runs find the operator's caches. `inspect` replaces the `ps` cleanup
 * reads processes with. */
async function createFixture(options: FixtureOptions) {
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
  /** Stops what the root records and removes it. When any of that cannot be confirmed, the root is kept, for what it
   * records, and the cleanup fails saying why. */
  const stop = async () => {
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
    const inspect = options.inspect ?? platformInspect;
    const daemon = await recordedDaemon(root, inspect);
    const leased = await readLeases(root);
    for (const path of leased.unreadable)
      problems.push(`the lease ${path} could not be read`);
    // The process table is read only when a lease names something to look for. One that cannot be read keeps the root.
    let unlisted = false;
    const scan = (): ProcessTable => {
      if (leased.leases.length === 0) return [];
      const table = processTable(inspect);
      if (table) return table;
      if (!unlisted)
        problems.push(
          "the process table could not be read, so nothing shows that the processes the leases name have exited",
        );
      unlisted = true;
      return [];
    };
    const first = scan();
    const groups = leased.leases.map((lease) => leasedGroup(lease, first));
    // The fixture's processes by pid and birth, gathered whenever a leased group's leader still proves the group is its own.
    const owned = new Map<number, string>();
    adoptMembers(owned, groups, first);
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
    adoptMembers(owned, groups, scan());
    const uninstalled = await succeeded(
      ["rigd", "uninstall"],
      rigd(["uninstall"]),
    );
    adoptMembers(owned, groups, scan());
    // A daemon that outlives this would run on with its root deleted, for as long as the machine stays up. One rigd
    // uninstall could not stop is asked to stop here; one that will not is killed.
    if (daemon !== undefined) {
      if (
        !uninstalled &&
        daemonIdentity(daemon.pid, inspect) === daemon.identity
      )
        process.kill(daemon.pid, "SIGTERM");
      if (!(await processExited(daemon, inspect))) {
        process.kill(daemon.pid, "SIGKILL");
        problems.push(
          `rigd ${daemon.pid} did not stop, and was killed${(await processExited(daemon, inspect)) ? "" : ", but is still running"}`,
        );
      }
    }
    // What rigd ran and did not stop is stopped here, and the root goes only once it has exited.
    const table = scan();
    adoptMembers(owned, groups, table);
    const surviving = table
      .filter((row) => owned.get(row.pid) === row.birth)
      .map((row) => ({
        pid: row.pid,
        identity: row.birth,
        named: `${row.pid} (${commandOf(row.pid, inspect)})`,
      }));
    if (surviving.length > 0) {
      for (const each of surviving) signalOwned(each, "SIGTERM", inspect);
      const stubborn: typeof surviving = [];
      for (const each of surviving)
        if (!(await processExited(each, inspect))) stubborn.push(each);
      for (const each of stubborn) signalOwned(each, "SIGKILL", inspect);
      for (const each of stubborn) await processExited(each, inspect);
      problems.push(
        `processes ${surviving.map(({ named }) => named).join(", ")} that rigd ran outlived rigd, and were stopped${stubborn.length > 0 ? `; ${stubborn.map(({ pid }) => pid).join(", ")} had to be killed` : ""}`,
      );
    }
    // Nothing may run on in a leased group: a member born once its leader had gone cannot be tied to the lease, so it is
    // named, never signalled.
    const pgids = new Set(groups.map((group) => group.pgid));
    const running = scan().filter(
      (row) => pgids.has(row.pgid) || owned.get(row.pid) === row.birth,
    );
    if (running.length > 0)
      problems.push(
        `processes ${running.map((row) => `${row.pid} (${commandOf(row.pid, inspect)})`).join(", ")} still run in process groups the root's leases name; the fixture signals only those it can tie to a lease`,
      );
    if (problems.length > 0)
      throw new Error(
        `The fixture could not confirm its cleanup, so its root is kept at ${base}:\n${problems.join("\n")}`,
      );
    await rm(base, { recursive: true, force: true });
  };
  let stopped: Promise<void> | undefined;
  /** `stop`, once: a later or concurrent cleanup, such as the test's own `finally` and `stopAbandonedFixtures` after a
   * timeout, answers as the first did. */
  const cleanup = () =>
    (stopped ??= stop().finally(() => unfinished.delete(cleanup)));
  unfinished.add(cleanup);
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

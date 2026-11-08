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
/** Runs `ps` with `args`: its exit status and what it printed. It throws when `ps` gave no answer to trust, which cleanup
 * treats as a read that proves nothing, keeping the root. A test substitutes one to see what cleanup does with what it is
 * told. */
export type Inspect = (args: readonly string[]) => {
  exitCode: number;
  stdout: string;
};
/** How long `ps` may take to answer. It blocks the test's thread meanwhile, where no Bun timeout reaches it. */
const INSPECT_ANSWER_MS = 10_000;
/** `command` with `args` appended, in the locale and zone rigd reads process birth times in, so a birth here is the one
 * its leases digest. One that has not answered within `ms` is killed, and throws. */
export function inspectWith(command: readonly string[], ms: number): Inspect {
  return (args) => {
    const ran = Bun.spawnSync([...command, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" },
      timeout: ms,
      killSignal: "SIGKILL",
    });
    if (ran.exitedDueToTimeout)
      throw new Error(
        `\`${[...command, ...args].join(" ")}\` did not answer within ${ms / 1000} s`,
      );
    return { exitCode: ran.exitCode, stdout: ran.stdout.toString() };
  };
}
export const platformInspect = inspectWith(["/bin/ps"], INSPECT_ANSWER_MS);
/** A process as `ps` shows it: when it started, which with its pid is all that names it, since a process that execs keeps
 * both, and a later process of that pid has another; and what it runs. */
type ProcessRow = { birth: string; command: string };
/** One row of `ps -o pid=,lstart=,command=`, its lstart in the C locale, as in `Thu Jan  1 00:00:00 1970`. */
const PROCESS_ROW =
  /^\s*(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})(?:\s+(.*))?$/;
/** One read of `pid`, asked together with the fixture's own process, which every read that worked lists: the row it shows
 * for `pid`; `gone` when it lists the fixture's process but not `pid`; `unknown` when it failed, or came back empty or
 * malformed, which shows nothing either way. */
function readProcess(
  pid: number,
  inspect: Inspect,
): ProcessRow | "gone" | "unknown" {
  const listed = inspect([
    "-p",
    `${pid},${process.pid}`,
    "-o",
    "pid=,lstart=,command=",
  ]);
  if (listed.exitCode !== 0) return "unknown";
  const rows = new Map<number, ProcessRow>();
  for (const line of listed.stdout.split("\n").filter((line) => line.trim())) {
    const row = PROCESS_ROW.exec(line);
    if (!row) return "unknown";
    rows.set(Number(row[1]), { birth: row[2]!, command: row[3] ?? "" });
  }
  if (
    !rows.has(process.pid) ||
    [...rows.keys()].some((other) => other !== pid && other !== process.pid)
  )
    return "unknown";
  return rows.get(pid) ?? "gone";
}
/** The reads of a process proved neither that it runs nor that it is gone. */
class InconclusiveReads extends Error {}
/** How many reads one look at a process may take before it counts as unknown. */
const READS_PER_LOOK = 3;
/** Looks for a process `is` accepts at `pid`: its row once a read shows one, `gone` once two reads that worked show none,
 * and `unknown` when neither happens within `READS_PER_LOOK` reads. One read that worked is never enough for `gone`, since
 * a truncated answer can leave the row out. */
function look(
  pid: number,
  inspect: Inspect,
  is: (row: ProcessRow) => boolean,
): ProcessRow | "gone" | "unknown" {
  let gone = 0;
  for (let read = 0; read < READS_PER_LOOK; read++) {
    const seen = readProcess(pid, inspect);
    if (seen === "unknown") continue;
    if (seen !== "gone" && is(seen)) return seen;
    if (++gone === 2) return "gone";
  }
  return "unknown";
}
export type ProcessState = "running" | "gone" | "unknown";
/** Whether `owned` still runs: `running` on a read that shows it, `gone` once two reads that worked show its pid absent or
 * another process's, `unknown` while the reads prove neither. */
export function processState(
  owned: { pid: number; identity: string },
  inspect: Inspect = platformInspect,
): ProcessState {
  const seen = look(owned.pid, inspect, (row) => row.birth === owned.identity);
  return typeof seen === "string" ? seen : "running";
}
/** When the process `pid` started, or undefined once it is gone. Throws when the reads of it prove neither. */
export function processIdentity(
  pid: number,
  inspect: Inspect = platformInspect,
): string | undefined {
  const seen = look(pid, inspect, () => true);
  if (seen === "unknown")
    throw new InconclusiveReads(
      `the reads of process ${pid} were inconclusive`,
    );
  return seen === "gone" ? undefined : seen.birth;
}
/** What the process `pid` runs, for a report: never what decides which process it is. */
const commandOf = (pid: number, inspect: Inspect) =>
  inspect(["-p", String(pid), "-o", "command="]).stdout.trim();
/** Every process with its group and birth, read at one instant, so a member and its birth are of the same process;
 * undefined when `ps` failed, which proves nothing about what runs. */
function processTable(inspect: Inspect) {
  let listed: ReturnType<Inspect>;
  try {
    listed = inspect(["-axo", "pid=,pgid=,lstart="]);
  } catch {
    return undefined;
  }
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
/** The rigd `root` records now, read before an uninstall removes that record, which it does before the process exits:
 * undefined when it records none, or none runs at the pid it records. Throws when the reads of that pid prove neither. */
export async function recordedDaemon(
  root: string,
  inspect: Inspect = platformInspect,
) {
  const { pid } = (await readFile(join(root, "daemon", "address.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => ({}))) as { pid?: number };
  if (pid === undefined) return undefined;
  const seen = look(pid, inspect, (row) => row.command.includes("rigd"));
  if (seen === "unknown")
    throw new InconclusiveReads(
      `the reads of rigd ${pid}, which the root records, were inconclusive`,
    );
  return seen === "gone" ? undefined : { pid, identity: seen.birth };
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
/** Signals `owned` while a read just before shows it is still that process: `sent`, or, unsignalled, `gone` when it has
 * exited or another process has its pid, and `unknown` when the reads prove neither. */
export function signalOwned(
  owned: { pid: number; identity: string },
  signal: NodeJS.Signals,
  inspect: Inspect,
): "sent" | "gone" | "unknown" {
  const state = processState(owned, inspect);
  if (state !== "running") return state;
  try {
    process.kill(owned.pid, signal);
    return "sent";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return "gone";
  }
}
/** How long a rigd or a Service may take to exit once it has been told to, on a machine as loaded as a test run makes it. */
const PROCESS_EXIT_MS = 15_000;
/** Waits for the process `owned` to exit: `gone` as soon as it has, otherwise what the last look found at the deadline. */
export async function awaitExit(
  owned: { pid: number; identity: string },
  inspect: Inspect = platformInspect,
): Promise<ProcessState> {
  const deadline = Date.now() + PROCESS_EXIT_MS;
  for (;;) {
    const state = processState(owned, inspect);
    if (state === "gone" || Date.now() >= deadline) return state;
    await Bun.sleep(20);
  }
}
/** How long cleanup waits for a test's commands to answer, and again once it has killed the process groups of those that
 * did not. */
const COMMAND_ANSWER_MS = 5_000;
/** Whether every one of `commands` has answered by `ms` from now; it answers as soon as they have. */
async function answeredWithin(
  commands: readonly { answered: Promise<unknown> }[],
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answered = await Promise.race([
    Promise.allSettled(commands.map(({ answered }) => answered)).then(
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  clearTimeout(timer);
  return answered;
}
/** The cleanup of every fixture whose cleanup has not yet answered. */
const unfinished = new Set<() => Promise<void>>();
/** Every fixture still being made, which registers its cleanup once it is. */
const starting = new Set<Promise<unknown>>();
/** Whether a fixture may be made. A sweep closes it, and only the start of a test or a test run opens it again, so whatever
 * is made while it is open has a sweep after it. A body Bun abandoned may still run on after a sweep, and what it asks
 * for then is refused. */
let open = true;
/** What was refused since the last sweep: a fixture asked for while making them was closed, or a command asked of a
 * fixture already being cleaned up. */
const refused: string[] = [];
/** Lets fixtures be made: called as each test, and each run of the tests, starts. */
export function openFixtures() {
  open = true;
}
/** Records a refusal for the next sweep to report, fails the run whether or not one follows, and throws it to the caller.
 * A caller may catch it, and no sweep may follow, so it is also thrown again on its own, which Bun reports as an unhandled
 * error wherever it runs, and the run's exit status is set: Bun 1.4.2 emits no `exit` or `beforeExit` in a test run. */
function refuse(reason: string): never {
  refused.push(reason);
  process.stderr.write(`Refused: ${reason}\n`);
  process.exitCode = 1;
  const error = new Error(reason);
  queueMicrotask(() => {
    throw error;
  });
  throw error;
}
/** Cleans up each fixture a test left unfinished, as Bun leaves one when it times the test out or the test throws before its
 * cleanup, and waits for a cleanup already under way: run once every test is done, so no fixture is still in use. Until
 * none is left, it waits for the fixtures still being made and cleans up what they register. No fixture can be made from
 * then until a test starts again. Fails naming each root it had to keep, and each refusal. */
export async function stopAbandonedFixtures() {
  open = false;
  const failed: string[] = [];
  while (starting.size > 0 || unfinished.size > 0) {
    await Promise.allSettled(starting);
    for (const result of await Promise.allSettled(
      [...unfinished].map((cleanup) => cleanup()),
    ))
      if (result.status === "rejected") failed.push(String(result.reason));
  }
  failed.push(...refused.splice(0));
  if (failed.length > 0)
    throw new Error(
      `A test left fixtures unfinished, and their cleanup failed or a fixture was refused:\n${failed.join("\n")}`,
    );
}
/** `createFixture`, while making fixtures is open: otherwise a fixture is refused before anything is made, since no
 * sweep would clean it up. */
export async function rigFixture(options: FixtureOptions = {}) {
  if (!open)
    refuse(
      "A fixture was asked for once the tests' fixtures were swept, by a test Bun had abandoned, and was refused.",
    );
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
  // Nothing runs from the root yet, and its cleanup is not yet registered: one that cannot be made is removed here.
  const canonicalRepo = await mkdir(repo)
    .then(() => realpath(repo))
    .catch(async (error: unknown) => {
      const removal = await rm(base, { recursive: true, force: true }).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      throw removal === undefined
        ? error
        : new Error(
            `The fixture could not be made (${error}), and its root ${base} could not be removed: ${removal}`,
          );
    });
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
  /** Runs `args` to its end, answering its exit status and output. `started` is told the pid of the process, which leads a
   * process group of its own when `detached`. */
  const execute = async (
    args: string[],
    cwd: string,
    detached = false,
    started: (pid: number) => void = () => {},
  ) => {
    const child = Bun.spawn(args, {
      cwd,
      env: environment,
      detached,
      stdout: "pipe",
      stderr: "pipe",
    });
    started(child.pid);
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  /** Set once cleanup has begun: from then the fixture runs only what its cleanup does. */
  let stopping = false;
  /** The test's commands that have not yet answered, each with the process group it leads and that leader's birth: a
   * process it starts in the background, holding its output open, is in that group too. */
  const inFlight = new Set<{
    named: string;
    group: number;
    leader: string | undefined | Error;
    answered: Promise<unknown>;
  }>();
  /** What `read` answers, or the error of a `ps` that gave no answer to trust. */
  const unthrown = <T>(read: () => T): T | Error => {
    try {
      return read();
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };
  const identityOf = (pid: number) =>
    unthrown(() => processIdentity(pid, options.inspect ?? platformInspect));
  /** `execute`, in a process group of its own, until cleanup has begun: a command asked for later, as by a body Bun
   * abandoned, could start what nothing stops, so it is refused. */
  const run = async (args: string[], cwd = repo) => {
    if (stopping)
      refuse(
        `The fixture at ${base} was being cleaned up, so \`${args.join(" ")}\` was refused.`,
      );
    let group = 0;
    // Spawned before `execute` first waits, so the group is known here.
    const answered = execute(args, cwd, true, (pid) => (group = pid));
    const command = {
      named: `\`${args.join(" ")}\``,
      group,
      leader: identityOf(group),
      answered,
    };
    inFlight.add(command);
    try {
      return await answered;
    } finally {
      inFlight.delete(command);
    }
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
  /** Waits a while for the test's commands still running, since what they start is in the record only once they have
   * answered. One that does not answer in time, as when a process it left in the background holds its output open, has
   * its process group killed while that group's leader is still the process it started; otherwise nothing is signalled.
   * Adds to `problems` each that did not answer, and a signal that failed, and never throws, so the daemon and leased
   * processes are still stopped. */
  const settleCommands = async (problems: string[]) => {
    const waiting = [...inFlight];
    if (await answeredWithin(waiting, COMMAND_ANSWER_MS)) return;
    const late = `had not answered ${COMMAND_ANSWER_MS / 1000} s after cleanup began`;
    const killed: typeof waiting = [];
    for (const command of waiting.filter((each) => inFlight.has(each))) {
      // The group is the command's only while its leader is still the process it started, read just before the signal.
      const started = command.leader;
      const leader =
        typeof started === "string"
          ? unthrown(() =>
              processState(
                { pid: command.group, identity: started },
                options.inspect ?? platformInspect,
              ),
            )
          : started;
      if (leader instanceof Error || leader === "unknown") {
        problems.push(
          `${command.named} ${late}, and its process group's leader could not be read (${leader instanceof Error ? leader.message : `the reads of process ${command.group} were inconclusive`}), so nothing was signalled; what holds its output open may still run`,
        );
        continue;
      }
      if (leader !== "running") {
        problems.push(
          `${command.named} ${late}, and its process group's leader is no longer the process it started, so nothing was signalled; what holds its output open may still run`,
        );
        continue;
      }
      try {
        process.kill(-command.group, "SIGKILL");
        killed.push(command);
      } catch (error) {
        problems.push(
          `${command.named} ${late}, and its process group could not be killed: ${error}`,
        );
      }
    }
    if (killed.length > 0)
      problems.push(
        `commands ${killed.map(({ named }) => named).join(", ")} ${late}, so their process groups were killed${(await answeredWithin(killed, COMMAND_ANSWER_MS)) ? "" : ", and they still have not answered"}`,
      );
  };
  /** Stops what the root records, adding to `problems` what it cannot confirm. It throws when a `ps` gives no answer to
   * trust. */
  const stopRecorded = async (problems: string[]) => {
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
    // A rigd whose reads were inconclusive may still run: it is asked to stop as one that does, and the root is kept.
    const daemon = await recordedDaemon(root, inspect).catch(
      (error: unknown) => {
        if (error instanceof InconclusiveReads) return error;
        throw error;
      },
    );
    if (daemon instanceof Error)
      problems.push(`${daemon.message}, so nothing shows that it stopped`);
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
        await succeeded(
          ["rig", ...args],
          execute([...commands.rig, ...args], base),
        );
      }
    adoptMembers(owned, groups, scan());
    const uninstalled = await succeeded(
      ["rigd", "uninstall"],
      execute([...commands.rigd, "uninstall"], base),
    );
    adoptMembers(owned, groups, scan());
    // A daemon that outlives this would run on with its root deleted, for as long as the machine stays up. One rigd
    // uninstall could not stop is asked to stop here; one that will not is killed.
    if (daemon !== undefined && !(daemon instanceof Error)) {
      if (!uninstalled) signalOwned(daemon, "SIGTERM", inspect);
      const exit = await awaitExit(daemon, inspect);
      if (exit !== "gone") {
        const stopped =
          exit === "running"
            ? "did not stop"
            : "could not be seen to stop, since the reads of it were inconclusive";
        const kill = signalOwned(daemon, "SIGKILL", inspect);
        const after = kill === "sent" ? await awaitExit(daemon, inspect) : kill;
        const killed =
          kill === "gone"
            ? "its pid no longer names that process, so it was not signalled"
            : kill === "unknown"
              ? "the reads of it just before its SIGKILL were inconclusive, so it was not signalled"
              : `was killed${after === "gone" ? "" : after === "running" ? ", but is still running" : ", but the reads of it since were inconclusive"}`;
        problems.push(`rigd ${daemon.pid} ${stopped}, and ${killed}`);
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
        if ((await awaitExit(each, inspect)) !== "gone") stubborn.push(each);
      const kills = stubborn.map((each) => ({
        ...each,
        kill: signalOwned(each, "SIGKILL", inspect),
      }));
      for (const each of kills)
        if (each.kill === "sent") await awaitExit(each, inspect);
      const pids = (kill: string) =>
        kills
          .filter((each) => each.kill === kill)
          .map(({ pid }) => pid)
          .join(", ");
      problems.push(
        `processes ${surviving.map(({ named }) => named).join(", ")} that rigd ran outlived rigd, and were stopped${pids("sent") ? `; ${pids("sent")} had to be killed` : ""}${pids("unknown") ? `; the reads of ${pids("unknown")} were inconclusive, so they were not killed` : ""}`,
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
  };
  /** Stops what the root records and removes it, after `problems` already found. When any of that cannot be confirmed,
   * the root is kept, for what it records, and the cleanup fails saying why. */
  const stop = async (problems: string[]) => {
    await stopRecorded(problems).catch((error: unknown) => {
      problems.push(
        `cleanup stopped short, so what it had yet to stop may still run: ${error}`,
      );
    });
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
    (stopped ??= (async () => {
      stopping = true;
      const problems: string[] = [];
      await settleCommands(problems);
      await stop(problems);
    })().finally(() => unfinished.delete(cleanup)));
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
    canonicalRepo,
  };
}

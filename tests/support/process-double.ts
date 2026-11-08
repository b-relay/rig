import { platformInspect, type Inspect } from "./rig-fixture";

/** Reads that show they prove nothing about a process:
 * - `failed`, `empty` and `partial`: ps failed, answered nothing, or was cut off inside a row;
 * - `commandless`: its row stops after the birth;
 * - `misborn`: its row has a birth no clock gives (`Xxx Yyy 99 99:99:99 9999`);
 * - `unlisted`: whole rows without the process, but of a process not asked for in place of the fixture's own;
 * - `unasked`: the fixture's row and a process not asked for, without the process;
 * - `failing`: the fixture's row alone, as an exit would show, but with ps exiting 1;
 * - `alone` and `alone-reborn`: the process's whole row without the fixture's, as it is or with another real birth. */
export const MALFORMED = [
  "failed",
  "empty",
  "partial",
  "commandless",
  "misborn",
  "unlisted",
  "unasked",
  "failing",
  "alone",
  "alone-reborn",
] as const;
/** Spoiled reads of a process: the malformed ones, and one cut off before its row, which still lists every other process
 * it asked for and so reads as the process gone; only a second read can tell it from an exit. */
export const FAULTS = [...MALFORMED, "truncated"] as const;
export type Fault = (typeof FAULTS)[number];
/** Each spoiled read once, and each malformed one every time: truncated reads that go on look like an exit, which a second
 * read is taken to confirm. */
export const SPOILED = [
  ...FAULTS.map((fault) => [fault, "once"] as const),
  ...MALFORMED.map((fault) => [fault, "always"] as const),
];
/** Spoiled reads of the process table: those of a process but `unasked`, since a table asks for every pid. */
export const TABLE_MALFORMED = MALFORMED.filter((fault) => fault !== "unasked");
/** Each spoiled table read that leaves the process's row out, once, and each malformed one every time. A read taken once
 * that still shows the row (`commandless`, `misborn`, `alone`, `alone-reborn`) is not among the first: a fixture that
 * trusted it would still see the process at its pid and group, so at the final look it would act as on an honest read. */
export const TABLE_SPOILED = [
  ...(
    ["failed", "empty", "partial", "unlisted", "failing", "truncated"] as const
  ).map((fault) => [fault, "once"] as const),
  ...TABLE_MALFORMED.map((fault) => [fault, "always"] as const),
];

/** The fields a read asks for, in order: those of each `-o` or `-axo` list, without their headers. */
function fieldsOf(args: readonly string[]) {
  return args.flatMap((arg, index) =>
    args[index - 1] === "-o" || args[index - 1] === "-axo"
      ? arg.split(",").map((field) => field.replace(/=$/, ""))
      : [],
  );
}
/** A row of the read `args` with `values`, by field. */
const rowWith = (args: readonly string[], values: Record<string, string>) =>
  fieldsOf(args)
    .map((field) => values[field] ?? "")
    .join(" ");
/** Whether `args` asks for `pid` by name. */
export function asksFor(args: readonly string[], pid: number) {
  const at = args.indexOf("-p");
  return at >= 0 && args[at + 1]!.split(",").includes(String(pid));
}
/** Whether `line`, a row of the read `args`, is the row of `pid`: a read that asks for no pid field asks for one pid. */
const rowOf = (args: readonly string[], line: string, pid: number) =>
  fieldsOf(args)[0] !== "pid" || Number(line.trim().split(/\s+/)[0]) === pid;
/** An lstart in the C locale. */
const LSTART = /[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}/;
/** `answer`'s rows, each of `pid` as `change` makes it. */
function changeRows(
  args: readonly string[],
  answer: ReturnType<Inspect>,
  pid: number,
  change: (line: string) => string,
) {
  const stdout = answer.stdout
    .split("\n")
    .map((line) =>
      line.trim() && rowOf(args, line, pid) ? change(line) : line,
    )
    .join("\n");
  return { ...answer, stdout };
}
/** `inspect`, except that a read asking for `pid()` by name shows it born at `birth`, as once another process has its
 * pid. */
export function reborn(
  inspect: Inspect,
  pid: () => number,
  birth: string,
): Inspect {
  return (args) => {
    const answer = inspect(args);
    return asksFor(args, pid())
      ? changeRows(args, answer, pid(), (line) => line.replace(LSTART, birth))
      : answer;
  };
}
/** `answer`'s rows but those of `pids`, with `added` after them: a read that asks for no pid field asks for one pid. */
function rowsBut(
  args: readonly string[],
  answer: ReturnType<Inspect>,
  pids: readonly number[],
  added: readonly string[] = [],
) {
  const rows = answer.stdout
    .split("\n")
    .filter(
      (line) => line.trim() && !pids.some((pid) => rowOf(args, line, pid)),
    );
  return [...rows, ...added].map((row) => `${row}\n`).join("");
}
/** `answer` as `fault` spoils it, for a read `args` asking for `pid`. */
function spoil(
  fault: Fault,
  args: readonly string[],
  answer: ReturnType<Inspect>,
  pid: number,
): ReturnType<Inspect> {
  const stranger = rowWith(args, {
    pid: "1",
    pgid: "1",
    lstart: "Thu Jan  1 00:00:00 1970",
    command: "/sbin/launchd",
  });
  switch (fault) {
    case "failed":
      return { exitCode: 1, stdout: "" };
    case "empty":
      return { exitCode: 0, stdout: "" };
    case "partial":
      return { exitCode: 0, stdout: "Thu Jan\n" };
    case "commandless":
      return changeRows(args, answer, pid, (line) =>
        line.replace(new RegExp(`(${LSTART.source}).*$`), "$1"),
      );
    case "misborn":
      return changeRows(args, answer, pid, (line) =>
        line.replace(LSTART, "Xxx Yyy 99 99:99:99 9999"),
      );
    case "unlisted":
      return {
        exitCode: 0,
        stdout: rowsBut(args, answer, [pid, process.pid], [stranger]),
      };
    case "unasked":
      return { exitCode: 0, stdout: rowsBut(args, answer, [pid], [stranger]) };
    case "failing":
      return { exitCode: 1, stdout: rowsBut(args, answer, [pid]) };
    case "alone":
      return { exitCode: 0, stdout: rowsBut(args, answer, [process.pid]) };
    case "alone-reborn": {
      const reborn = changeRows(args, answer, pid, (line) =>
        line.replace(LSTART, "Fri Jan  2 00:00:00 1970"),
      );
      return { exitCode: 0, stdout: rowsBut(args, reborn, [process.pid]) };
    }
    case "truncated": {
      const stdout = rowsBut(args, answer, [pid]);
      return { exitCode: stdout ? 0 : 1, stdout };
    }
  }
}

/** `inspect`, except that the `n`th read asking for the process `pid()` answers as `fault(n)` spoils it, when it does.
 * `counts` picks the reads that are numbered and spoiled instead, such as those of the whole process table. */
export function spoiling(
  inspect: Inspect,
  pid: () => number,
  fault: (read: number) => Fault | undefined,
  counts: (args: readonly string[]) => boolean = (args) => asksFor(args, pid()),
): Inspect {
  let reads = 0;
  return (args) => {
    if (!counts(args)) return inspect(args);
    const spoiled = fault(++reads);
    const answer = inspect(args);
    return spoiled ? spoil(spoiled, args, answer, pid()) : answer;
  };
}

/** A pid no real process has: ps refuses one this large, so it answers only through a double. */
export const FAKE_PID = 987654321;
/** A process at `FAKE_PID` that runs `command`, shown to whatever reads processes through `inspect`, with the birth
 * `birth(n)` gives at its `n`th read by pid, until a signal in `endsOn` ends it. `process.kill` to its pid is recorded
 * in `signals` and sent nowhere, and each read moves `Date.now` a minute on, so every wait for it to exit runs out at its
 * first look. `fault` spoils reads that ask for it by pid, by number, as `spoiling` does, and `tableFault` reads of the
 * whole process table, numbered apart. `restore` puts `Date.now` and `process.kill` back. */
export function fakeProcess(options: {
  command: string;
  endsOn: readonly NodeJS.Signals[];
  birth?: (read: number) => string;
  fault?: (read: number) => Fault | undefined;
  tableFault?: (read: number) => Fault | undefined;
}) {
  const pid = FAKE_PID;
  const birth = options.birth ?? (() => "Thu Jan  1 00:00:00 1970");
  let alive = true;
  let reads = 0;
  let skew = 0;
  const signals: unknown[] = [];
  /** The real processes, read once: only the fake's row changes from one table read to the next. */
  const tables = new Map<string, ReturnType<Inspect>>();
  const realTable = (args: readonly string[]) => {
    const key = args.join(" ");
    const read = tables.get(key) ?? platformInspect(args);
    if (read.exitCode === 0) tables.set(key, read);
    return read;
  };
  const shown: Inspect = (args) => {
    const table = args[0] === "-axo";
    const at = args.indexOf("-p");
    const others = table
      ? []
      : args[at + 1]!.split(",").filter((each) => each !== String(pid));
    const real = table
      ? realTable(args)
      : others.length > 0
        ? platformInspect(
            args.map((arg, index) =>
              index === at + 1 ? others.join(",") : arg,
            ),
          )
        : { exitCode: 1, stdout: "" };
    if (!alive) return real;
    const row = rowWith(args, {
      pid: String(pid),
      pgid: String(pid),
      lstart: table ? birth(reads) : birth(++reads),
      command: options.command,
    });
    return { exitCode: 0, stdout: `${real.stdout}${row}\n` };
  };
  const answered = spoiling(
    spoiling(
      (args) =>
        args[0] === "-axo" || asksFor(args, pid)
          ? shown(args)
          : platformInspect(args),
      () => pid,
      options.fault ?? (() => undefined),
    ),
    () => pid,
    options.tableFault ?? (() => undefined),
    (args) => args[0] === "-axo",
  );
  const inspect: Inspect = (args) => {
    skew += 60_000;
    return answered(args);
  };
  const now = Date.now;
  const kill = process.kill;
  Date.now = () => now() + skew;
  process.kill = ((target: number, signal?: NodeJS.Signals | number) => {
    if (target !== pid) return kill.call(process, target, signal);
    signals.push(signal);
    if (options.endsOn.includes(signal as NodeJS.Signals)) alive = false;
    return true;
  }) as typeof process.kill;
  return {
    pid,
    identity: birth(1),
    inspect,
    signals,
    alive: () => alive,
    restore() {
      Date.now = now;
      process.kill = kill;
    },
  };
}

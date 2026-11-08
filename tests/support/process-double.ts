import { platformInspect, type Inspect } from "./rig-fixture";

/** Reads that show they prove nothing about a process: one that failed, one that came back empty, and one cut off inside a
 * row. */
export const MALFORMED = ["failed", "empty", "partial"] as const;
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

/** The fields a read asks for, in order: those of each `-o` or `-axo` list, without their headers. */
function fieldsOf(args: readonly string[]) {
  return args.flatMap((arg, index) =>
    args[index - 1] === "-o" || args[index - 1] === "-axo"
      ? arg.split(",").map((field) => field.replace(/=$/, ""))
      : [],
  );
}
/** Whether `args` asks for `pid` by name. */
export function asksFor(args: readonly string[], pid: number) {
  const at = args.indexOf("-p");
  return at >= 0 && args[at + 1]!.split(",").includes(String(pid));
}
/** Whether `line`, a row of the read `args`, is the row of `pid`: a read that asks for no pid field asks for one pid. */
const rowOf = (args: readonly string[], line: string, pid: number) =>
  fieldsOf(args)[0] !== "pid" || Number(line.trim().split(/\s+/)[0]) === pid;
/** `inspect`, except that a read asking for `pid()` by name shows it born at `birth`, as once another process has its
 * pid. */
export function reborn(
  inspect: Inspect,
  pid: () => number,
  birth: string,
): Inspect {
  return (args) => {
    const answer = inspect(args);
    if (!asksFor(args, pid())) return answer;
    const stdout = answer.stdout
      .split("\n")
      .map((line) =>
        line.trim() && rowOf(args, line, pid())
          ? line.replace(
              /[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}/,
              birth,
            )
          : line,
      )
      .join("\n");
    return { ...answer, stdout };
  };
}
/** `answer` without its row for `pid`, as a read cut off before it: a read that asks for no pid field asks for `pid` alone. */
function withoutRow(
  args: readonly string[],
  answer: ReturnType<Inspect>,
  pid: number,
) {
  const rows = answer.stdout
    .split("\n")
    .filter((line) => line.trim() && !rowOf(args, line, pid));
  return {
    exitCode: rows.length > 0 ? 0 : 1,
    stdout: rows.map((row) => `${row}\n`).join(""),
  };
}

/** `inspect`, except that the `n`th read asking for the process `pid()` answers as `fault(n)` spoils it, when it does. */
export function spoiling(
  inspect: Inspect,
  pid: () => number,
  fault: (read: number) => Fault | undefined,
): Inspect {
  let reads = 0;
  return (args) => {
    if (!asksFor(args, pid())) return inspect(args);
    const spoiled = fault(++reads);
    if (spoiled === "failed") return { exitCode: 1, stdout: "" };
    if (spoiled === "empty") return { exitCode: 0, stdout: "" };
    if (spoiled === "partial") return { exitCode: 0, stdout: "Thu Jan\n" };
    const answer = inspect(args);
    return spoiled === "truncated" ? withoutRow(args, answer, pid()) : answer;
  };
}

/** A pid no real process has: ps refuses one this large, so it answers only through a double. */
export const FAKE_PID = 987654321;
/** A process at `FAKE_PID` that runs `command`, shown to whatever reads processes through `inspect`, with the birth
 * `birth(n)` gives at its `n`th read by pid, until a signal in `endsOn` ends it. `process.kill` to its pid is recorded
 * in `signals` and sent nowhere, and each read moves `Date.now` a minute on, so every wait for it to exit runs out at its
 * first look. `fault` spoils reads that ask for it by pid, by number, as `spoiling` does. `restore` puts `Date.now` and
 * `process.kill` back. */
export function fakeProcess(options: {
  command: string;
  endsOn: readonly NodeJS.Signals[];
  birth?: (read: number) => string;
  fault?: (read: number) => Fault | undefined;
}) {
  const pid = FAKE_PID;
  const birth = options.birth ?? (() => "Thu Jan  1 00:00:00 1970");
  let alive = true;
  let reads = 0;
  let skew = 0;
  const signals: unknown[] = [];
  const shown: Inspect = (args) => {
    const table = args[0] === "-axo";
    const at = args.indexOf("-p");
    const others = table
      ? []
      : args[at + 1]!.split(",").filter((each) => each !== String(pid));
    const real = table
      ? platformInspect(args)
      : others.length > 0
        ? platformInspect(
            args.map((arg, index) =>
              index === at + 1 ? others.join(",") : arg,
            ),
          )
        : { exitCode: 1, stdout: "" };
    if (!alive) return real;
    const values: Record<string, string> = {
      pid: String(pid),
      pgid: String(pid),
      lstart: table ? birth(reads) : birth(++reads),
      command: options.command,
    };
    const row = fieldsOf(args)
      .map((field) => values[field] ?? "")
      .join(" ");
    return { exitCode: 0, stdout: `${real.stdout}${row}\n` };
  };
  const answered = spoiling(
    (args) =>
      args[0] === "-axo" || asksFor(args, pid)
        ? shown(args)
        : platformInspect(args),
    () => pid,
    options.fault ?? (() => undefined),
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

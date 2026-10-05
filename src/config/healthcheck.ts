/** A Service's `healthcheck` (ADR 0012): Docker Compose's shape, read into what Rig runs. Pure; no I/O. */

/** Compose's defaults where Rig keeps them, and Rig's own start_period: Compose's 0s would leave start no time to pass. */
export const HEALTHCHECK_DEFAULTS = {
  interval: "30s",
  timeout: "30s",
  retries: 3,
  start_period: "30s",
  on_failure: "report",
} as const;
/** The shortest interval between ongoing checks. */
export const MIN_HEALTHCHECK_INTERVAL_SECONDS = 5;

/** What a healthcheck's `test` asks for, before references are resolved:
 * - `url`: an HTTP GET of a local http(s) URL that must answer below 400 without following redirects (Rig's extension);
 * - `shell`: a command run with /bin/sh -c that must exit 0 (a string, or `["CMD-SHELL", command]`);
 * - `exec`: a program and its arguments run without a shell (`["CMD", program, ...arguments]`), from index 1 of the list.
 * A shell command's `at` is where it sits under `test`: the string itself, or the list's second entry. */
export type HealthcheckTest =
  | { kind: "url"; url: string }
  | { kind: "shell"; command: string; at: "" | ".1" }
  | { kind: "exec"; argv: readonly string[] };

/** The healthcheck settings of one Service as rig.yaml spells them; every field is optional. */
export interface HealthcheckSettings {
  test?: string | readonly string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  start_period?: string;
  disable?: boolean;
  on_failure?: "report" | "restart";
}

/** Whether `value` is an http(s) URL check rather than a shell command, in any letter case. A string starting with '/' is a
 * shell command (an executable path), never a path on the Service's port. */
export function isHealthUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Whether the Service has a healthcheck in force: one is written, it is not `disable: true`, and its test is not
 * `["NONE"]`. A Service without one behaves exactly as one with no healthcheck key at all. */
export function healthcheckInForce(
  settings: HealthcheckSettings | undefined,
): settings is HealthcheckSettings {
  if (settings === undefined || settings.disable === true) return false;
  const test = settings.test;
  return !(Array.isArray(test) && test[0] === "NONE");
}

/** The test a healthcheck in force runs; undefined when it names none, in which case Rig checks that every declared port
 * accepts a connection, as it does for a Service without a healthcheck. */
export function healthcheckTest(
  settings: HealthcheckSettings,
): HealthcheckTest | undefined {
  const test = settings.test;
  if (test === undefined) return undefined;
  if (typeof test === "string")
    return isHealthUrl(test)
      ? { kind: "url", url: test }
      : { kind: "shell", command: test, at: "" };
  if (test[0] === "CMD-SHELL")
    return { kind: "shell", command: test[1] ?? "", at: ".1" };
  return { kind: "exec", argv: test.slice(1) };
}

/** Why a list-form `test` is not one of Compose's forms; undefined when it is one. A `CMD` argument may be empty, as an
 * argv entry may; its program and a `CMD-SHELL` command may not. */
export function healthcheckListProblem(
  test: readonly string[],
): string | undefined {
  const [form, ...rest] = test;
  if (form === "NONE")
    return rest.length
      ? '["NONE"] takes nothing after NONE; write test: ["NONE"]'
      : undefined;
  if (form === "CMD-SHELL")
    return rest.length !== 1 || rest[0]!.trim() === ""
      ? 'CMD-SHELL takes exactly one shell command, such as ["CMD-SHELL", "curl -f http://127.0.0.1:${port}/health"]'
      : isHealthUrl(rest[0]!)
        ? "an HTTP check is written as a plain string, such as test: http://127.0.0.1:${port}/health; CMD-SHELL runs a shell command"
        : undefined;
  if (form === "CMD")
    return rest.length && rest[0] !== ""
      ? undefined
      : 'CMD needs a program to run, such as ["CMD", "pg_isready", "-h", "127.0.0.1"]';
  return 'a list test must start with "CMD", "CMD-SHELL" or "NONE"';
}

/** A `CMD` program and its arguments as one /bin/sh command that runs it with exactly those arguments. Every word is
 * single-quoted, the program included, so none is ever shell syntax: not split, globbed or expanded, and never read as
 * an assignment (`A=1`), a reserved word or an operator (`(`). The command starts with a quote, so it is never taken for
 * an HTTP check either. */
export function execCommand(argv: readonly string[]): string {
  return argv.map((value) => `'${value.replaceAll("'", `'\\''`)}'`).join(" ");
}

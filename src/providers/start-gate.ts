import type { Writable } from "node:stream";

/** How a gated process ends when its gate closes without a release: its starter died before it could lease it. */
const START_GATE_CLOSED_EXIT_CODE = 125;
/** The PATH a lookup uses when the process environment names none, like the shell that runs the gate. */
const DEFAULT_LOOKUP_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** The command a supervisor spawns so that `command` runs only once it is released: a shell that waits for one line on its
 * standard input, then replaces itself with `command` (standard input from /dev/null). Until the release nothing of `command`
 * runs; a starter that dies first closes the gate, and the shell ends with START_GATE_CLOSED_EXIT_CODE without running it. The
 * replacement keeps the pid, the process group and the birth time, so an identity read before the release is `command`'s
 * identity, and `command` keeps its own argv. */
export function gatedCommand(command: readonly string[]): readonly string[] {
  return [
    "/bin/sh",
    "-c",
    `IFS= read -r release || exit ${START_GATE_CLOSED_EXIT_CODE}; exec -- "$@" </dev/null`,
    "rig-start",
    ...command,
  ];
}

/** Releases a gated process through the gate its starter holds. Resolves once the release is with the operating system,
 * which the gated process then reads even if its starter dies. Rejects when the release is refused; a gated process that is
 * already gone may also resolve it, and its end is then observed like any other exit. */
export function releaseGate(gate: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    // Stays attached: a gate whose process is gone may say so after the release, which must never throw in the starter.
    gate.on("error", reject);
    gate.end("\n", (error?: Error | null) =>
      error ? reject(error) : resolve(),
    );
  });
}

/** Whether `executable` names a program the gate can run: a path (resolved against `cwd`) to an executable file, or a name
 * found on the `PATH` the process will get. A spawn would have failed at once for a missing program; the gate only fails once
 * released, so the supervisor asks first. A program that is found but still cannot run (a missing interpreter, a format the
 * system cannot execute) ends once released with the shell's code 126 or 127, like a component command that fails. */
export function findsExecutable(
  executable: string,
  place: { readonly cwd: string; readonly PATH: string | undefined },
): boolean {
  return (
    Bun.which(executable, {
      cwd: place.cwd,
      PATH: place.PATH ?? DEFAULT_LOOKUP_PATH,
    }) !== null
  );
}

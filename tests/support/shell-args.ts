import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The shell a printed command is copied into: zsh, the macOS login shell, which expands more than sh does (`=ls`), or
 * sh where it is missing. */
const SHELL = Bun.which("zsh") ?? "/bin/sh";

/** The arguments `rig` receives when a user pastes `line` into a shell: the shell runs it with `rig` defined as a function
 * that records its arguments, so quoting, expansion (`$HOME`, `$((1+1))`) and redirections are the shell's own. Throws
 * when the shell refuses the line, as for an unmatched quote, or when it never runs rig. Runs in an empty directory,
 * with no rc files and an environment of PATH alone. */
export function shellArgs(line: string): string[] {
  const directory = mkdtempSync(join(tmpdir(), "rig-shell-args-"));
  const record = join(directory, "args");
  try {
    const result = Bun.spawnSync(
      [
        SHELL,
        "-f",
        "-c",
        `rig() { printf '%s\\0' "$@" > "$RIG_ARGS_FILE"; }\n${line}`,
      ],
      {
        cwd: directory,
        env: { PATH: "/usr/bin:/bin", RIG_ARGS_FILE: record },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      },
    );
    if (!result.success)
      throw new Error(
        `the shell refused ${line}: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`,
      );
    let recorded: string;
    try {
      recorded = readFileSync(record, "utf8");
    } catch {
      throw new Error(`the shell never ran rig for ${line}`);
    }
    return recorded === "" ? [] : recorded.slice(0, -1).split("\0");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

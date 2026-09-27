import { constants } from "node:os";

/** How a launchd job's last run ended, as `launchctl print` reports it. */
export type LaunchdJobExit =
  { readonly exitCode: number } | { readonly signal: string };

/** The last run's end in `launchctl print gui/<uid>/<label>` output, or nothing when the job never exited or the output
 * names no end. launchd prints `last exit code = <n>` after an exit, `last terminating signal = <description>: <n>`
 * after a signal, and `last exit code = (never exited)` while it has not ended; only top-level job lines count, so an
 * environment value that looks like one is never read as evidence. */
export function parseLaunchdJobExit(
  printed: string,
): LaunchdJobExit | undefined {
  const signal = printed.match(/^\tlast terminating signal = .*: (\d+)$/m);
  if (signal) {
    const name = signalName(Number(signal[1]));
    return name === undefined ? undefined : { signal: name };
  }
  const code = printed.match(/^\tlast exit code = (-?\d+)$/m);
  return code ? { exitCode: Number(code[1]) } : undefined;
}

/** "SIGTERM" for 15; nothing for a number this platform does not name. */
function signalName(number: number): string | undefined {
  return Object.entries(constants.signals).find(
    ([, value]) => value === number,
  )?.[0];
}

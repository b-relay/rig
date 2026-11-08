import type { MonitorResult, RuntimeCommand } from "../daemon/protocol";
import type { CliDependencies } from "./types";
import { screenView, type TerminalSize } from "./live-region";
import { monitorLines } from "./monitor-output";
import type { MonitorWindowInput } from "./monitor-command";
import { logTimeWindow } from "./log-window";
import { endsOnCancel } from "./stream-cancel";

/** What watching Monitor uses: rigd's client, the wait between samples and the clock, cancellation, and the stdout
 * terminal with its size. */
export type MonitorWatchDependencies = Pick<
  CliDependencies,
  "client" | "output" | "wait" | "signal" | "now"
> & { outputTerminal: () => TerminalSize };

/** `rig monitor` on a terminal: the table redrawn on the alternate screen after every sample, with the time it was
 * read, until cancellation; then the last table is left on the main screen. A read that fails ends the watch with that
 * failure, written below it. */
export async function watchMonitor(
  request: RuntimeCommand,
  first: unknown,
  window: MonitorWindowInput | undefined,
  dependencies: MonitorWatchDependencies,
): Promise<void> {
  const size = dependencies.outputTerminal;
  const view = screenView((text) => dependencies.output.write(text), size);
  const clock = dependencies.now ?? (() => new Date());
  let result = first as MonitorResult;
  try {
    while (!dependencies.signal?.aborted) {
      view.draw([
        ...monitorLines(result, {
          columns: size().columns,
          ...(window ? { window } : {}),
        }),
        "",
        `Updated ${clock().toLocaleTimeString()} · Ctrl-C to stop`,
      ]);
      await dependencies.wait(result.sampledEvery * 1000, dependencies.signal);
      if (dependencies.signal?.aborted) return;
      // A duration is resolved again, so the window moves with the clock; an ISO time stays where it was.
      const next = await dependencies.client
        .command(
          window
            ? { ...request, window: logTimeWindow(window, clock()) }
            : request,
          dependencies.signal,
        )
        .catch(endsOnCancel(dependencies.signal));
      if (next === undefined) return;
      result = next as MonitorResult;
    }
  } finally {
    view.close();
  }
}

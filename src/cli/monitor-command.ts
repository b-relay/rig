import type { Command } from "commander";
import { RigError } from "../domain/errors";
import type { ExecuteCommand } from "./commands";
import { logTimeWindow } from "./log-window";

interface MonitorOptions {
  project?: string;
  all?: boolean;
  since: string;
  until?: string;
  json?: boolean;
}

/** The window `rig monitor` was given, as typed: each a duration back from now or an ISO time with a zone. */
export interface MonitorWindowInput {
  readonly since: string;
  readonly until?: string;
}

const HELP = `
CPU reads as Activity Monitor shows it: 100% is one full core. Memory is each
process's physical footprint (its resident size on a Mac where rigd samples with
ps). Median and peak cover the window from --since to --until.

Times are a duration back from now, such as 90s, 15m, 1h, 2d or 1w (parts
combine, as in 1h30m), or an ISO time with a zone, such as 2026-10-12T03:00:00Z.
Without --until the window ends now: on a terminal the table fills the screen
and is redrawn every sample until you press Ctrl-C, which leaves the last table
below your earlier output; a duration moves with the clock. With --until,
piped, or with --json, it is printed once.

Examples:
  rig monitor
  rig monitor --all --since 24h
  rig monitor --project fletcher --since 2026-10-12T02:00:00Z --until 2026-10-12T04:00:00Z
`;

/** `rig monitor`: one Project's CPU and memory (the one in the current directory, or `--project`), or with `--all` the
 * whole Host's. */
export function addMonitorCommand(
  command: Command,
  {
    execute,
    projectScope,
    now,
  }: {
    execute: ExecuteCommand;
    /** The grammar's one check of `--project`. */
    projectScope(options: { project?: string }): { project?: string };
    /** The clock a duration counts back from. */
    now: () => Date;
  },
  cwd: string,
): void {
  command
    .command("monitor")
    .description(
      "Watch the CPU and memory of a Project's Services and Jobs, or of the whole Host.",
    )
    .option("--project <name>", "Registered Project identity")
    .option(
      "--all",
      "Every Project on the Host, Rig itself and the Host's total",
    )
    .option(
      "--since <time>",
      "Start of the window the median and peak cover",
      "1h",
    )
    .option("--until <time>", "End of the window; absent, it ends now")
    .option("--json", "Print the report once as JSON")
    .addHelpText("after", HELP)
    .action(async (options: MonitorOptions) => {
      if (options.all && options.project !== undefined)
        throw new RigError(
          "USAGE",
          "--all covers every Project, so it cannot be combined with --project.",
          "Drop --project to watch the whole Host, or drop --all to watch one Project.",
        );
      const window: MonitorWindowInput = {
        since: options.since,
        ...(options.until === undefined ? {} : { until: options.until }),
      };
      await execute(
        {
          action: "monitor",
          window: logTimeWindow(window, now()),
          ...(options.all
            ? { host: true }
            : { repoPath: cwd, ...projectScope(options) }),
        },
        {
          json: options.json,
          follow: options.json !== true && options.until === undefined,
          window,
        },
      );
    });
}

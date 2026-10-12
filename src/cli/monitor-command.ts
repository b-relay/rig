import { Option, type Command } from "commander";
import { USAGE_RANGES, type UsageRange } from "../domain/usage-summary";
import { RigError } from "../domain/errors";
import type { ExecuteCommand } from "./commands";

interface MonitorOptions {
  project?: string;
  all?: boolean;
  range: UsageRange;
  json?: boolean;
}

const HELP = `
CPU reads as Activity Monitor shows it: 100% is one full core. Memory is each
process's physical footprint. Median and peak cover the range.

On a terminal the table is redrawn every sample until you press Ctrl-C;
piped, or with --json, it is printed once.

Examples:
  rig monitor
  rig monitor --all
  rig monitor --project fletcher --range 7d
`;

/** `rig monitor`: one Project's CPU and memory (the one in the current directory, or `--project`), or with `--all` the
 * whole Host's. */
export function addMonitorCommand(
  command: Command,
  {
    execute,
    projectScope,
  }: {
    execute: ExecuteCommand;
    /** The grammar's one check of `--project`. */
    projectScope(options: { project?: string }): { project?: string };
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
    .addOption(
      new Option("--range <span>", "Span the median and peak cover")
        .choices(USAGE_RANGES)
        .default("1h"),
    )
    .option("--json", "Print the report once as JSON")
    .addHelpText("after", HELP)
    .action(async (options: MonitorOptions) => {
      if (options.all && options.project !== undefined)
        throw new RigError(
          "USAGE",
          "--all covers every Project, so it cannot be combined with --project.",
          "Drop --project to watch the whole Host, or drop --all to watch one Project.",
        );
      await execute(
        {
          action: "monitor",
          range: options.range,
          ...(options.all
            ? { host: true }
            : { repoPath: cwd, ...projectScope(options) }),
        },
        { json: options.json, follow: options.json !== true },
      );
    });
}

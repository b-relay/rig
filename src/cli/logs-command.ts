import { Option, type Command } from "commander";
import { logComponentName, type RuntimeCommand } from "../daemon/protocol";
import { RigError } from "../domain/errors";
import type { ExecuteCommand } from "./commands";
import { logTimeWindow } from "./log-window";
import { terminalText } from "./terminal-text";

interface LogsOptions {
  project?: string;
  deployment?: string;
  lines: number;
  follow?: boolean;
  service?: string[];
  stream?: "stdout" | "stderr";
  since?: string;
  until?: string;
}
/** The most --service names one request carries, as the control plane allows. */
const MAX_SERVICES = 64;
const TIME_HELP = `
Times are a duration back from now, such as 90s, 15m, 1h, 2d or 1w (parts
combine, as in 1h30m), or an ISO time with a zone, such as 2026-09-28T03:00:00Z
or 2026-09-28T05:00:00+02:00. Both bounds are inclusive. Lines launchd wrote
without a time are left out once --since or --until is set.

Examples:
  rig logs --service scheduler --since 1h
  rig logs stable --stream stderr --follow
  rig logs stable --since 2026-09-28T03:00:00Z --until 2026-09-28T04:00:00Z
`;

/** `rig logs`: the grammar checks every flag, resolves durations against `now`, and sends one request; rigd checks the
 * Service names against the Target. */
export function addLogsCommand(
  command: Command,
  {
    execute,
    now,
    targetRequest,
    nonEmpty,
    positiveInteger,
  }: {
    execute: ExecuteCommand;
    /** The clock `--since 1h` and `--until 1h` count back from. */
    now: () => Date;
    /** The grammar's one check of a Target selection. */
    targetRequest(
      target: string | undefined,
      branch: string | undefined,
      options: { project?: string; deployment?: string },
    ): RuntimeCommand;
    /** The grammar's argument parsers, shared with every command. */
    nonEmpty(value: string): string;
    positiveInteger(value: string): number;
  },
): void {
  command
    .command("logs")
    .description("Read recent Target logs, including stopped Targets.")
    .argument(
      "[target]",
      "working (the default), stable, or preview with a Branch",
    )
    .argument("[branch]", "Preview Branch or name", nonEmpty)
    .option("--project <name>", "Registered Project identity")
    .option("--deployment <name>", "Explicit Preview name")
    .option(
      "--follow",
      "Keep printing new lines until interrupted, after the matching history; every filter but --until applies",
    )
    .option(
      "--lines <count>",
      "Number of recent entries, counted after filtering",
      positiveInteger,
      50,
    )
    .option(
      "--service <name>",
      "Only this Service's or Tool's lines (repeat for more than one)",
      (value: string, previous: string[] | undefined) => [
        ...(previous ?? []),
        value,
      ],
    )
    .addOption(
      new Option("--stream <stream>", "Only lines of this stream").choices([
        "stdout",
        "stderr",
      ]),
    )
    .option(
      "--since <time>",
      "Only lines recorded at or after this time, such as 1h or an ISO time",
    )
    .option(
      "--until <time>",
      "Only lines recorded at or before this time, such as 1h or an ISO time",
    )
    .addHelpText("after", TIME_HELP)
    .action(
      async (
        target: string | undefined,
        branch: string | undefined,
        options: LogsOptions,
      ) => {
        if (options.lines > 10000)
          throw new RigError(
            "USAGE",
            "Request at most 10000 recent log entries.",
            "Reduce --lines.",
          );
        const logFilter = logsFilter(options, now());
        await execute(
          {
            ...targetRequest(target, branch, options),
            lines: options.lines,
            ...(logFilter ? { logFilter } : {}),
          },
          { follow: options.follow },
        );
      },
    );
}

/** The filter the flags ask for, or undefined when none narrows the read, so an unfiltered request is unchanged. */
function logsFilter(
  options: LogsOptions,
  now: Date,
): RuntimeCommand["logFilter"] {
  const services = [...new Set(options.service ?? [])];
  if (services.length > MAX_SERVICES)
    throw new RigError(
      "USAGE",
      `--service is given ${services.length} names; rig logs takes at most ${MAX_SERVICES}.`,
      "Pass fewer --service names, or none to read every Service.",
    );
  for (const name of services)
    if (!logComponentName.safeParse(name).success)
      throw new RigError(
        "USAGE",
        `--service '${terminalText(name)}' is not a Service name.`,
        "Pass a Service or Tool name from rig.yaml, such as --service web.",
      );
  if (options.until !== undefined && options.follow)
    throw new RigError(
      "USAGE",
      "--until cannot be combined with --follow: a follow waits for lines newer than any bound.",
      "Drop --until to follow, or drop --follow to read up to that time.",
    );
  const window = logTimeWindow(options, now);
  const filter: NonNullable<RuntimeCommand["logFilter"]> = {
    ...(services.length ? { services } : {}),
    ...(options.stream ? { stream: options.stream } : {}),
    ...window,
  };
  return Object.keys(filter).length ? filter : undefined;
}

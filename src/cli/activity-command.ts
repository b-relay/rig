import { Option, type Command } from "commander";
import type { RuntimeCommand } from "../daemon/protocol";
import { OPERATION_OUTCOMES } from "../domain/activity";
import { RigError } from "../domain/errors";
import type { ExecuteCommand } from "./commands";
import { logTimeWindow } from "./log-window";

interface ActivityOptions {
  project?: string;
  all?: boolean;
  target?: string;
  action?: string;
  outcome?: (typeof OPERATION_OUTCOMES)[number];
  since?: string;
  until?: string;
  lines: number;
  json?: boolean;
}
/** The records rigd keeps, so the most one read can list. */
const MAX_LINES = 1000;
const HELP = `
Without --project or --all, the Project of the directory it runs in. Times are
a duration back from now, such as 90s, 15m, 1h, 2d or 1w (parts combine, as in
1h30m), or an ISO time with a zone, such as 2026-09-28T03:00:00Z. Both bounds
are inclusive. When records are left out, stderr says how many.

Examples:
  rig activity --since 1d --outcome failed
  rig activity --target stable --action deploy --lines 5
  rig activity --all --json > activity.jsonl
  rig activity 3f2a9c1e
`;

/** `rig activity`: one Operation by id, or the newest records of a Project (or with --all, the Host), narrowed by the
 * filters. rigd filters before it answers, so only what is shown crosses the control plane. */
export function addActivityCommand(
  command: Command,
  {
    cwd,
    execute,
    now,
    projectScope,
    positiveInteger,
    nonEmpty,
  }: {
    cwd: string;
    execute: ExecuteCommand;
    /** The clock `--since 1h` and `--until 1h` count back from. */
    now: () => Date;
    projectScope(options: { project?: string }): { project?: string };
    positiveInteger(value: string): number;
    nonEmpty(value: string): string;
  },
): void {
  command
    .command("activity")
    .description(
      "Read what Rig did: the newest records of this Project, or of every Project with --all.",
    )
    .argument(
      "[operation]",
      "Show one Operation by the id a failed command printed",
    )
    .option("--project <name>", "Registered Project identity")
    .option("--all", "Every Project's records and rigd's own")
    .option(
      "--target <name>",
      "Only this Target's records: working, stable or a Preview's name",
      nonEmpty,
    )
    .option(
      "--action <action>",
      "Only records of this action, such as deploy, crash or job",
      nonEmpty,
    )
    .addOption(
      new Option(
        "--outcome <outcome>",
        "Only records with this outcome",
      ).choices(OPERATION_OUTCOMES),
    )
    .option(
      "--since <time>",
      "Only records at or after this time, such as 1h or an ISO time",
    )
    .option(
      "--until <time>",
      "Only records at or before this time, such as 1h or an ISO time",
    )
    .option(
      "--lines <count>",
      "Number of newest records, counted after filtering",
      positiveInteger,
      20,
    )
    .option("--json", "Print each record as one line of JSON")
    .addHelpText("after", HELP)
    .action(async (operation: string | undefined, options: ActivityOptions) => {
      if (options.all && options.project !== undefined)
        throw new RigError(
          "USAGE",
          "--all and --project cannot be combined.",
          "Pass --project for one Project's records, or --all for every Project's.",
        );
      if (options.lines > MAX_LINES)
        throw new RigError(
          "USAGE",
          `Request at most ${MAX_LINES} records; rigd keeps no more.`,
          "Reduce --lines.",
        );
      // The lengths the control plane takes, checked here so a long value is named rather than read as version skew.
      if ((options.target?.length ?? 0) > 63)
        throw new RigError(
          "USAGE",
          "--target is longer than any Target name (63 characters).",
          "Pass working, stable or a Preview's name.",
        );
      if ((options.action?.length ?? 0) > 64)
        throw new RigError(
          "USAGE",
          "--action is longer than any action name (64 characters).",
          "Pass an action as rig activity lists it, such as deploy, crash or job.",
        );
      const activityFilter = filterOf(options, now());
      if (operation !== undefined && activityFilter)
        throw new RigError(
          "USAGE",
          "An Operation id cannot be combined with filters.",
          "Pass the id alone to see that Operation's records, or drop it to filter.",
        );
      await execute(
        {
          action: "activity",
          repoPath: cwd,
          ...projectScope(options),
          ...(options.all ? { host: true } : {}),
          ...(operation === undefined
            ? { lines: options.lines }
            : { operation }),
          ...(activityFilter ? { activityFilter } : {}),
        },
        { json: options.json },
      );
    });
}

/** The filter the flags ask for, or undefined when none narrows the read. */
function filterOf(
  options: ActivityOptions,
  now: Date,
): RuntimeCommand["activityFilter"] {
  const filter: NonNullable<RuntimeCommand["activityFilter"]> = {
    ...(options.target !== undefined ? { target: options.target } : {}),
    ...(options.action !== undefined ? { action: options.action } : {}),
    ...(options.outcome !== undefined ? { outcome: options.outcome } : {}),
    ...logTimeWindow(options, now),
  };
  return Object.keys(filter).length ? filter : undefined;
}

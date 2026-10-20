import type { DiagnosticLog } from "../diagnostics/types";
import type { DaemonAdmin, UserOutput } from "./types";
import { addHelpCommand, commandPath, terminalCommand } from "./commands";
import { isHelp, recordDiagnostic, reportFailure } from "./failure";
import { object, renderResult } from "./output";
import type { UpgradeRequest, UpgradeResult } from "../daemon/upgrade";
import { RigError } from "../domain/errors";

export interface RigdCliDependencies {
  admin: DaemonAdmin;
  output: UserOutput;
  diagnostics: DiagnosticLog;
  newOperationId: () => string;
  /** Runs one managed Component from the request file rigd wrote; returns the wrapper's exit code. */
  capture(requestFile: string): Promise<number>;
  /** Installs a release, or says whether one is newer (see daemon/upgrade); absent where rigd cannot reach releases. */
  upgrade?(request: UpgradeRequest): Promise<UpgradeResult>;
}
/** Daemon administration is explicit and separate from normal Project requests. */
export async function runRigdCli(
  args: readonly string[],
  dependencies: RigdCliDependencies,
): Promise<number> {
  const command = terminalCommand("rigd", dependencies.output).description(
    "Install and inspect the local Rig daemon.",
  );
  let operationId: string | undefined;
  let exitCode = 0;
  for (const action of ["install", "status", "uninstall"] as const) {
    command
      .command(action)
      .description(
        {
          install: "Install and verify the local daemon.",
          status: "Observe installation, process, and reachability.",
          uninstall: "Uninstall after all Targets have stopped.",
        }[action],
      )
      .action(async () => {
        operationId = dependencies.newOperationId();
        await recordDiagnostic(dependencies.diagnostics, {
          event: "command.started",
          action,
          operationId,
        });
        const result =
          action === "status"
            ? await dependencies.admin.status()
            : await dependencies.admin[action](operationId);
        dependencies.output.write(renderResult(`daemon-${action}`, result));
        if (action === "status" && object(result).reachable !== true)
          exitCode = 1;
        const evidence = await recordDiagnostic(dependencies.diagnostics, {
          event: "command.completed",
          action,
          operationId,
        });
        if (evidence.error) dependencies.output.error(`${evidence.error}\n`);
      });
  }
  command
    .command("upgrade")
    .description(
      "Install the latest release of Rig, or the one named: rig, rigd and the dashboard, through that release's own install script, then restart rigd. A release already installed is installed again when rig, its dashboard or a rigd serving it is missing.",
    )
    .argument(
      "[version]",
      "A release such as 0.2.0, to upgrade or roll back to; the latest when absent",
    )
    .option(
      "--check",
      "Only say whether that release differs from the one installed, or is installed incompletely",
    )
    .action(
      async (version: string | undefined, options: { check?: boolean }) => {
        operationId = dependencies.newOperationId();
        await recordDiagnostic(dependencies.diagnostics, {
          event: "command.started",
          action: "upgrade",
          operationId,
        });
        if (!dependencies.upgrade)
          throw new RigError(
            "COMMAND_UNAVAILABLE",
            "rigd upgrade is unavailable here.",
            "Run it from a terminal on the Host.",
          );
        const result = await dependencies.upgrade({
          ...(version !== undefined ? { version } : {}),
          check: options.check === true,
        });
        dependencies.output.write(renderResult("daemon-upgrade", result));
        await recordDiagnostic(dependencies.diagnostics, {
          event: "command.completed",
          action: "upgrade",
          operationId,
        });
      },
    );
  command
    .command("capture")
    .description(
      "Run one managed Component from a request file rigd wrote (rigd's child supervisor invokes this; not for direct use).",
    )
    .argument("<request-file>", "Capture request file written by rigd")
    .action(async (requestFile: string) => {
      exitCode = await dependencies.capture(requestFile);
    });
  addHelpCommand(command, "rigd");
  try {
    await command.parseAsync(args.length ? [...args] : ["--help"], {
      from: "user",
    });
    return exitCode;
  } catch (error) {
    if (isHelp(error)) return 0;
    await reportFailure(error, {
      diagnostics: dependencies.diagnostics,
      output: dependencies.output,
      executable: ["rigd", ...commandPath(command, args)].join(" "),
      operationId,
    });
    return 1;
  }
}

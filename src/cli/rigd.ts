import type { DiagnosticLog } from "../diagnostics/types";
import type { DaemonAdmin, UserOutput } from "./types";
import { terminalCommand } from "./commands";
import { isHelp, recordDiagnostic, reportFailure } from "./failure";
import { renderResult } from "./output";

export interface RigdCliDependencies {
  admin: DaemonAdmin;
  output: UserOutput;
  diagnostics: DiagnosticLog;
  newOperationId: () => string;
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
        const evidence = await recordDiagnostic(dependencies.diagnostics, {
          event: "command.completed",
          action,
          operationId,
        });
        if (evidence.error) dependencies.output.error(`${evidence.error}\n`);
      });
  }
  try {
    await command.parseAsync(args.length ? [...args] : ["--help"], {
      from: "user",
    });
    return 0;
  } catch (error) {
    if (isHelp(error)) return 0;
    await reportFailure(error, {
      diagnostics: dependencies.diagnostics,
      output: dependencies.output,
      executable: "rigd",
      operationId,
    });
    return 1;
  }
}

import { CommanderError } from "commander";
import { RigError, asRigError, userCorrectable } from "../domain/errors";
import type {
  DiagnosticEntry,
  DiagnosticLog,
  DiagnosticWriteResult,
} from "../diagnostics/types";
import type { UserOutput } from "./types";

/** Logging failure never replaces the user's command outcome. */
export async function recordDiagnostic(
  log: DiagnosticLog,
  entry: DiagnosticEntry,
): Promise<DiagnosticWriteResult> {
  try {
    return await log.record(entry);
  } catch {
    return { error: "Diagnostic evidence could not be recorded." };
  }
}
export function isHelp(error: unknown): boolean {
  return (
    error instanceof CommanderError &&
    (error.code === "commander.helpDisplayed" ||
      error.code === "commander.help" ||
      error.code === "commander.version")
  );
}
/** The user detached from a mutation rigd is still running: not a failure, so
 * it is recorded as its own event and points at the record rigd will finish. */
export async function reportDetached(
  operationId: string,
  input: { diagnostics: DiagnosticLog; output: UserOutput; json?: boolean },
): Promise<number> {
  const message = `Detached from operation ${operationId}; rigd finishes it in the background.`;
  const hint = `Run rig activity ${operationId} to see its outcome.`;
  const evidence = await recordDiagnostic(input.diagnostics, {
    event: "command.detached",
    level: "info",
    operationId,
  });
  if (input.json)
    input.output.write(
      `${JSON.stringify({ error: { code: "DETACHED", message, hint, operationId } })}\n`,
    );
  else input.output.error(`${message}\n${hint}\n`);
  if (evidence.error) input.output.error(`${evidence.error}\n`);
  return 130;
}
/** Owns terminal error policy; provider failure details never cross this Interface. */
export async function reportFailure(
  error: unknown,
  input: {
    diagnostics: DiagnosticLog;
    output: UserOutput;
    executable: string;
    operationId?: string;
    json?: boolean;
  },
): Promise<void> {
  const failure =
    error instanceof CommanderError
      ? new RigError(
          "USAGE",
          error.message.replace(/^error:\s*/i, ""),
          `Run ${input.executable} --help.`,
        )
      : asRigError(error);
  const evidence = await recordDiagnostic(input.diagnostics, {
    event: "command.failed",
    level: "error",
    ...(input.operationId ? { operationId: input.operationId } : {}),
    code: failure.code,
  });
  const unexpected = !userCorrectable(failure.code);
  if (input.json) {
    input.output.write(
      `${JSON.stringify({ error: { code: failure.code, message: failure.message, hint: failure.hint, ...(unexpected && input.operationId ? { operationId: input.operationId } : {}), ...(unexpected && evidence.path ? { diagnosticPath: evidence.path } : {}) } })}\n`,
    );
  } else {
    input.output.error(`${failure.message}\n${failure.hint}\n`);
    if (unexpected && input.operationId)
      input.output.error(
        `Operation: ${input.operationId} (rig activity ${input.operationId})\n`,
      );
    if (unexpected && evidence.path)
      input.output.error(`Details: ${evidence.path}\n`);
  }
  if (evidence.error) input.output.error(`${evidence.error}\n`);
}

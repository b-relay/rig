import { CommanderError } from "commander";
import { RigError, asRigError } from "../domain/errors";
import type {
  DiagnosticEntry,
  DiagnosticLog,
  DiagnosticWriteResult,
} from "../diagnostics/types";
import type { UserOutput } from "./types";

const expectedCodes = new Set([
  "TARGET_REQUIRED",
  "PRODUCTION_CONFIRMATION",
  "CANCELLED",
  "USAGE",
  "DAEMON_MISSING",
  "DAEMON_UNREACHABLE",
  "PROJECT_REQUIRED",
  "PROJECT_MISSING",
  "TARGET_MISSING",
  "PREVIEW_REQUIRED",
  "DEPLOY_TARGET",
  "BRANCH_POLICY",
  "PROJECT_NAME",
  "PROJECT_IDENTITY",
  "PROJECT_CONFLICT",
  "PROJECT_PATH_CONFLICT",
  "TARGETS_RUNNING",
  "PROJECT_ACTIVE",
  "PATH_REQUIRED",
]);

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
      error.code === "commander.help")
  );
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
  const unexpected = !expectedCodes.has(failure.code);
  if (input.json) {
    input.output.write(
      `${JSON.stringify({ error: { code: failure.code, message: failure.message, hint: failure.hint, ...(unexpected && input.operationId ? { operationId: input.operationId } : {}), ...(unexpected && evidence.path ? { diagnosticPath: evidence.path } : {}) } })}\n`,
    );
  } else {
    input.output.error(`${failure.message}\n${failure.hint}\n`);
    if (unexpected && input.operationId)
      input.output.error(`Operation: ${input.operationId}\n`);
    if (unexpected && evidence.path)
      input.output.error(`Details: ${evidence.path}\n`);
  }
  if (evidence.error) input.output.error(`${evidence.error}\n`);
}

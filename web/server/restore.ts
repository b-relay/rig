import { z } from "zod";
import { commandSchema } from "../../src/daemon/protocol";
import { restoreConfirmed } from "../lib/backups";
import type { RuntimeCommand } from "../lib/types";

/* The dashboard's Restore (ADR 0017), decided on the server: a restore reaches rigd only through `runRestore`, and only
 * with the job's name typed. Server-only, since the command grammar it checks against is rigd's own. */

/** What the dashboard's Restore sends its own server action: the command, and what was typed to confirm it. */
export const restoreRequestSchema = z.strictObject({
  command: commandSchema
    .refine(
      (command) =>
        command.action === "restore" &&
        command.job !== undefined &&
        command.backup !== undefined &&
        command.backup !== "latest",
    )
    .describe(
      "The restore the dialog asks rigd to run, in rigd's own command grammar: the restore action, naming its job and one backup by its id, never latest, so the backup the dialog showed is the one restored.",
    ),
  typed: z
    .string()
    .max(256)
    .describe(
      "What was typed in the Restore dialog to confirm, up to 256 characters. The restore runs only when, with surrounding whitespace trimmed, it is the job's name exactly.",
    ),
});
/** Pure: the restore command `input` asks for once what was typed names its job exactly, or why it is refused. The
 * dashboard always names the backup by its id, so what was shown is what is restored. The server decides this; the
 * dialog's disabled button is only a courtesy. */
export function confirmedRestore(
  input: unknown,
):
  | { ok: true; command: RuntimeCommand }
  | { ok: false; failure: { code: string; message: string; hint: string } } {
  const request = restoreRequestSchema.safeParse(input);
  if (!request.success)
    return {
      ok: false,
      failure: {
        code: "INVALID_REQUEST",
        message: "The browser sent a restore rigd's grammar does not accept.",
        hint: "Reload the dashboard; its build may be older than rigd.",
      },
    };
  const { command, typed } = request.data;
  if (!restoreConfirmed(typed, command.job!))
    return {
      ok: false,
      failure: {
        code: "RESTORE_CONFIRMATION",
        message: `A restore runs only once ${command.job}'s name is typed to confirm it.`,
        hint: `Type ${command.job} in the Restore dialog, then press Restore.`,
      },
    };
  return { ok: true, command };
}

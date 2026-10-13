"use server";

import { cookies, headers } from "next/headers";
import { commandSchema } from "../../src/daemon/protocol";
import { configEditorRequestSchema } from "../../src/daemon/config-editor";
import { envEditorRequestSchema } from "../../src/daemon/env-editor";
import type { ActivityResult, QueueResult, Settlement } from "../lib/types";
import {
  attempt,
  refused,
  succeeded,
  type Failure,
  type Outcome,
} from "../lib/outcome";
import { admit, clientName, keyMatches, sessionCookie } from "./guard";
import { editConfig, editEnv, read } from "./daemon";
import { sitePolicy } from "./site";
import { confirmedRestore } from "./restore";
import { DNS_DELETE_ELSEWHERE, confirmedDnsDelete } from "./dns";

/** Server Actions: the only way the browser changes anything. Each one decides the request
 * again, exactly as the proxy did, so a page is never the only thing between a POST and rigd. */

async function admission(signingIn = false): Promise<Failure | undefined> {
  const decision = admit(
    { method: "POST", headers: await headers() },
    await sitePolicy(),
    { now: Date.now(), signingIn },
  );
  return decision.admitted
    ? undefined
    : { code: decision.code, message: decision.message };
}
const invalid = (what: string): Failure => ({
  code: "INVALID_REQUEST",
  message: `The browser sent ${what} rigd's grammar does not accept.`,
  hint: "Reload the dashboard; its build may be older than rigd.",
});
/** Runs one command, read or mutation, and answers rigd's reply or refusal. */
export async function runCommand(input: unknown): Promise<Outcome<unknown>> {
  const denied = await admission();
  if (denied) return refused(denied);
  const command = commandSchema.safeParse(input);
  if (!command.success) return refused(invalid("a command"));
  // A restore replaces data and a DNS delete takes a name offline: each goes only through its own action, which
  // requires the typed confirmation.
  if (command.data.action === "restore")
    return refused({
      code: "RESTORE_CONFIRMATION",
      message: "A restore needs its typed confirmation.",
      hint: "Use Restore on the Jobs tab, which asks for the job's name.",
    });
  if (command.data.action === "dns-delete")
    return refused(DNS_DELETE_ELSEWHERE);
  return attempt(read(command.data));
}
/** Restores a backup, as `rig backup restore <job> <id> <target> --yes` does, only once what was typed names the job:
 * decided here, so no page script can skip the dialog. */
export async function runRestore(input: unknown): Promise<Outcome<unknown>> {
  const denied = await admission();
  if (denied) return refused(denied);
  const confirmed = confirmedRestore(input);
  if (!confirmed.ok) return refused(confirmed.failure);
  return attempt(read(confirmed.command));
}
/** Deletes a DNS record, as the Delete dialog asks, only with the record as the page read it and the name typed to
 * confirm; rigd compares that name with the record it reads just before deleting. */
export async function runDnsDelete(input: unknown): Promise<Outcome<unknown>> {
  const denied = await admission();
  if (denied) return refused(denied);
  const confirmed = confirmedDnsDelete(input);
  if (!confirmed.ok) return refused(confirmed.failure);
  return attempt(read(confirmed.command));
}
/** Reads, previews, or applies structured edits to a Project's rig.yaml. */
export async function runConfigEdit(input: unknown): Promise<Outcome<unknown>> {
  const denied = await admission();
  if (denied) return refused(denied);
  const request = configEditorRequestSchema.safeParse(input);
  if (!request.success) return refused(invalid("a config edit"));
  return attempt(editConfig(request.data));
}
/** Reads, reveals, or writes an operator env file (a secret). Who asked is named here, from the
 * request's own admission, never by the browser; rigd records it in Activity with the names changed.
 * The input may hold a value: it is never logged, and a refusal never repeats it. */
export async function runEnvEdit(input: unknown): Promise<Outcome<unknown>> {
  const requestHeaders = await headers();
  const decision = admit(
    { method: "POST", headers: requestHeaders },
    await sitePolicy(),
    { now: Date.now() },
  );
  if (!decision.admitted)
    return refused({ code: decision.code, message: decision.message });
  const request = envEditorRequestSchema.safeParse(
    typeof input === "object" &&
      input !== null &&
      (input as { action?: unknown }).action === "write"
      ? {
          ...input,
          actor: clientName(decision, requestHeaders.get("x-forwarded-for")),
        }
      : input,
  );
  if (!request.success) return refused(invalid("an env file change"));
  return attempt(editEnv(request.data));
}
/** Where an Operation stands whose reply never reached the browser: still queued or running,
 * finished with a recorded outcome, or unknown to rigd. */
export async function settleOperation(
  operationId: string,
): Promise<Outcome<Settlement>> {
  const denied = await admission();
  if (denied) return refused(denied);
  if (typeof operationId !== "string" || !operationId)
    return refused(invalid("an operation id"));
  return attempt(
    (async (): Promise<Settlement> => {
      const queue = (await read({
        action: "queue",
        operation: operationId,
      })) as QueueResult;
      if (queue.operation?.state === "running") return { state: "running" };
      const activity = (await read({
        action: "activity",
        operation: operationId,
      })) as ActivityResult;
      const record = activity.operations
        .filter((each) => each.id === operationId)
        .at(-1);
      if (record)
        return {
          state: "finished",
          outcome: record.outcome,
          occurredAt: record.occurredAt,
          ...(record.message ? { message: record.message } : {}),
        };
      return queue.operation?.state === "waiting"
        ? { state: "waiting" }
        : { state: "unknown" };
    })(),
  );
}
/** Trades the access key for the session cookie the browser's later requests carry. */
export async function signIn(
  key: unknown,
): Promise<Outcome<{ signedIn: true }>> {
  const denied = await admission(true);
  if (denied) return refused(denied);
  const policy = await sitePolicy();
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > 256 ||
    !policy.accessKey ||
    !keyMatches(key, policy.accessKey)
  )
    return refused({
      code: "KEY_REFUSED",
      message: "That is not this Host's access key.",
      hint: "On the Mac that serves this site, read the key file: ~/.rig/auth/dashboard.key for the dashboard that comes with Rig; a working copy or Preview names its own in its log (rig logs).",
    });
  const { header: _header, ...cookie } = sessionCookie(
    policy.accessKey,
    Date.now(),
  );
  (await cookies()).set(cookie);
  return succeeded({ signedIn: true });
}

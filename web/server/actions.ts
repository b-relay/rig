"use server";

import { cookies, headers } from "next/headers";
import { commandSchema } from "../../src/daemon/protocol";
import { configEditorRequestSchema } from "../../src/daemon/config-editor";
import type { ActivityResult, QueueResult, Settlement } from "../lib/types";
import {
  attempt,
  refused,
  succeeded,
  type Failure,
  type Outcome,
} from "../lib/outcome";
import { admit, keyMatches, sessionCookie } from "./guard";
import { editConfig, read } from "./daemon";
import { sitePolicy } from "./site";

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
  return attempt(read(command.data));
}
/** Reads, previews, or applies structured edits to a Project's rig.yaml. */
export async function runConfigEdit(input: unknown): Promise<Outcome<unknown>> {
  const denied = await admission();
  if (denied) return refused(denied);
  const request = configEditorRequestSchema.safeParse(input);
  if (!request.success) return refused(invalid("a config edit"));
  return attempt(editConfig(request.data));
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
      const queue = (await read({ action: "queue" })) as QueueResult;
      if (queue.running?.operationId === operationId)
        return { state: "running" };
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
      return queue.waiting > 0 ? { state: "waiting" } : { state: "unknown" };
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
      hint: "On the Mac that serves this site, the web Service's log names the key file: rig logs live --project rig.",
    });
  const { header: _header, ...cookie } = sessionCookie(
    policy.accessKey,
    Date.now(),
  );
  (await cookies()).set(cookie);
  return succeeded({ signedIn: true });
}

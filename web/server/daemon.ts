import { z } from "zod";
import type { DaemonClient } from "../../src/daemon/client";
import { configEditorReplySchemas } from "../../src/daemon/config-editor";
import { connectDaemon, liveDaemonAddress } from "../../src/daemon/connection";
import { envEditorReplySchemas } from "../../src/daemon/env-editor";
import { RigError } from "../../src/domain/errors";
import type {
  Action,
  ConfigEditorRequest,
  EnvEditorRequest,
  Reply,
  RuntimeCommand,
} from "../lib/types";
import { site } from "./site";

/** The site's rigd: the Host's, or the sandbox's when this copy is a Preview. Discovered afresh for each request,
 * since a restarted rigd has a new port, and the way rig discovers it: the token goes only to the daemon whose
 * recorded process is verified to still run. */
export function daemon(root = site().root): Promise<DaemonClient> {
  return connectDaemon(root);
}
/** One command, answered with the reply its action carries. Reads keep rigd's deadlines; a
 * mutation waits as long as rigd takes. */
export async function read<A extends Action>(
  command: RuntimeCommand & { action: A },
  signal?: AbortSignal,
): Promise<Reply<A>> {
  return (await (await daemon()).command(command, signal)) as Reply<A>;
}
const protocolFailure = (what: string) =>
  new RigError(
    "DAEMON_PROTOCOL",
    `rigd returned an invalid ${what}.`,
    "Check that rig and rigd use the same version.",
  );
type ConfigReply<A extends ConfigEditorRequest["action"]> = z.infer<
  (typeof configEditorReplySchemas)[A]
>;
type EnvReply<A extends EnvEditorRequest["action"]> = z.infer<
  (typeof envEditorReplySchemas)[A]
>;
/** The config editor route, which rig itself does not call: a read, a preview, or an apply. */
export async function editConfig<A extends ConfigEditorRequest["action"]>(
  request: ConfigEditorRequest & { action: A },
  root = site().root,
): Promise<ConfigReply<A>> {
  return (await postEditor(
    "/v1/config",
    request,
    configEditorReplySchemas[request.action],
    root,
  )) as ConfigReply<A>;
}
/** The env editor route for operator env files: names, one revealed value, or a write. The request
 * may hold a value, so it is never logged; rigd's refusals never echo it either. */
export async function editEnv<A extends EnvEditorRequest["action"]>(
  request: EnvEditorRequest & { action: A },
  root = site().root,
): Promise<EnvReply<A>> {
  return (await postEditor(
    "/v1/env",
    request,
    envEditorReplySchemas[request.action],
    root,
  )) as EnvReply<A>;
}
const refusalSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    hint: z.string().optional(),
    // A config validation failure names each field's problem; the page shows each beside its field.
    issues: z
      .array(z.object({ path: z.array(z.string()), message: z.string() }))
      .optional(),
  }),
});
/** Posts one editor request and answers its result only once it matches the action's reply schema. */
async function postEditor(
  path: "/v1/config" | "/v1/env",
  request: unknown,
  reply: z.ZodType,
  root: string,
): Promise<unknown> {
  const editor = path === "/v1/config" ? "config editor" : "env editor";
  const address = await liveDaemonAddress(root);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${address.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      redirect: "error",
    });
  } catch {
    throw new RigError(
      "DAEMON_UNREACHABLE",
      "rigd is not reachable.",
      "Run 'rigd status' to inspect the daemon.",
    );
  }
  if (response.status === 404)
    throw new RigError(
      "DAEMON_OUTDATED",
      "This rigd does not offer that editor yet.",
      "Run rigd install from this version of Rig to upgrade the daemon.",
    );
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const refusal = refusalSchema.safeParse(payload);
    if (!refusal.success) throw protocolFailure(`${editor} refusal`);
    const { code, message, hint, issues } = refusal.data.error;
    throw new RigError(
      code,
      message,
      hint ?? "Run 'rigd status'.",
      issues ? { issues } : {},
    );
  }
  const answered = z.object({ result: reply }).safeParse(payload);
  if (!answered.success) throw protocolFailure(`${editor} reply`);
  return answered.data.result;
}

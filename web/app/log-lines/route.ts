import { commandSchema } from "../../../src/daemon/protocol";
import { attempt, refused } from "@/lib/outcome";
import { read } from "@/server/daemon";

/** One page of a Target's log, for the log viewer's follow. A plain GET rather than a Server Action:
 * Next runs Server Actions one at a time, so a follow read would otherwise wait behind a deploy
 * started from the same page, exactly when its lines matter. It sits behind the same admission as
 * every page (web/proxy.ts), reads only, and never caches. `q` is the logs command as JSON. */
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  let input: unknown;
  try {
    input = JSON.parse(new URL(request.url).searchParams.get("q") ?? "");
  } catch {
    input = undefined;
  }
  const command = commandSchema.safeParse(
    typeof input === "object" && input !== null
      ? { ...input, action: "logs" }
      : undefined,
  );
  if (!command.success)
    return Response.json(
      refused({
        code: "INVALID_REQUEST",
        message: "The browser sent a log read rigd's grammar does not accept.",
        hint: "Reload the dashboard; its build may be older than rigd.",
      }),
      { headers },
    );
  return Response.json(await attempt(read(command.data, request.signal)), {
    headers,
  });
}

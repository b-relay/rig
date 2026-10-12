import { commandSchema } from "../../../src/daemon/protocol";
import { attempt, refused } from "@/lib/outcome";
import { chartReport } from "@/lib/usage";
import { read } from "@/server/daemon";

/** The Monitor pages' poll: one Project's or the whole Host's CPU and memory, cut to what the charts draw. A plain GET,
 * as the log viewer's follow is, so it never waits behind a Server Action; it sits behind the same admission as every
 * page (web/proxy.ts), reads only, and never caches. `q` is the monitor command as JSON. */
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
      ? { ...input, action: "monitor" }
      : undefined,
  );
  if (!command.success)
    return Response.json(
      refused({
        code: "INVALID_REQUEST",
        message:
          "The browser sent a monitor read rigd's grammar does not accept.",
        hint: "Reload the dashboard; its build may be older than rigd.",
      }),
      { headers },
    );
  const outcome = await attempt(
    read({ ...command.data, action: "monitor" }, request.signal),
  );
  return Response.json(
    outcome.ok ? { ok: true, value: chartReport(outcome.value) } : outcome,
    { headers },
  );
}

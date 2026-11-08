import { commandSchema } from "../../../src/daemon/protocol";
import { attempt, refused } from "@/lib/outcome";
import { chartReport, monitorsTarget, presetWindow } from "@/lib/usage";
import { read } from "@/server/daemon";
import { usageQuerySchema } from "@/server/usage-query";

/** The Monitor pages' poll: one Project's or the whole Host's CPU and memory, cut to what the charts draw. A plain GET,
 * as the log viewer's follow is, so it never waits behind a Server Action; it sits behind the same admission as every
 * page (web/proxy.ts), reads only, and never caches. `q` is `{host: true, range}` or `{project, target, range}` as JSON; the
 * preset is resolved to a window here, at every poll, so the chart always ends now. */
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  let input: unknown;
  try {
    input = JSON.parse(new URL(request.url).searchParams.get("q") ?? "");
  } catch {
    input = undefined;
  }
  const query = usageQuerySchema.safeParse(input);
  const command = query.success
    ? commandSchema.safeParse({
        action: "monitor",
        window: presetWindow(query.data.range, Date.now()),
        ...("host" in query.data
          ? { host: true }
          : { project: query.data.project }),
      })
    : undefined;
  if (!query.success || !command?.success)
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
  if (
    outcome.ok &&
    "target" in query.data &&
    !monitorsTarget(
      query.data.target,
      outcome.value.targets ?? [],
      outcome.value.series,
    )
  )
    return Response.json(
      refused({
        code: "TARGET_MISSING",
        message: `${query.data.project} has no Target ${query.data.target}, now or in this range.`,
        hint: "Reload the page, which shows a Target the Project has.",
      }),
      { headers },
    );
  return Response.json(
    outcome.ok
      ? {
          ok: true,
          value: chartReport(
            outcome.value,
            query.data.range,
            "target" in query.data ? query.data.target : undefined,
          ),
        }
      : outcome,
    { headers },
  );
}

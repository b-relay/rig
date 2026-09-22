import { readPulse } from "@/server/pulse";

/** What the live refresh polls: a stamp that changes when rigd's record did. It sits behind
 * the same sign-in as every page, and never caches. */
export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  return Response.json(await readPulse(), {
    headers: { "cache-control": "no-store" },
  });
}

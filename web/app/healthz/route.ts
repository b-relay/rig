/** The readiness check rigd polls; it says the site is up, not that rigd is. */
export const dynamic = "force-dynamic";
export function GET(): Response {
  return new Response("ok", { headers: { "cache-control": "no-store" } });
}

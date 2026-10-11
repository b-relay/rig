import { faviconCache, faviconUrl } from "@/server/favicon";
import { projectStatus } from "@/server/status";

const icons = faviconCache({ fetch, now: Date.now });

/** A Project's icon: the favicon of its stable Target's published site, read by the server and
 * served from this origin, or 404 so the page shows the Project's monogram. It sits behind the
 * same admission as every page (web/proxy.ts), and the site it reads is the one rigd records for
 * the Project, never one the request names. */
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  const project = new URL(request.url).searchParams.get("project");
  const status = project ? await projectStatus(project) : undefined;
  const route = status?.ok
    ? status.value.targets.find((target) => target.kind === "stable")?.route
    : undefined;
  const url = route ? faviconUrl(route) : undefined;
  const icon = url ? await icons.get(url) : undefined;
  if (!icon)
    return new Response(null, {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  return new Response(icon.body, {
    headers: {
      "content-type": icon.type,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      "cache-control": "private, max-age=600",
    },
  });
}

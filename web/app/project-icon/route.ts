import { faviconCache, projectIconResponse } from "@/server/favicon";
import { projectStatus } from "@/server/status";

const icons = faviconCache({ fetch, now: Date.now });
/** Each Project's stable hostname, kept a minute so a page of icons is not one status read each. */
const routes = new Map<string, { at: number; route: string | undefined }>();
async function stableRoute(project: string): Promise<string | undefined> {
  const hit = routes.get(project);
  if (hit && Date.now() - hit.at < 60_000) return hit.route;
  const status = await projectStatus(project);
  const route = status.ok
    ? status.value.targets.find((target) => target.kind === "stable")?.route
    : undefined;
  routes.set(project, { at: Date.now(), route });
  return route;
}

/** A Project's icon: the favicon of its stable Target's published site, read by the server and
 * served from this origin, or 404 so the page shows the Project's monogram. It sits behind the
 * same admission, Content-Security-Policy and no-store as every page (web/proxy.ts). */
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  return projectIconResponse(new URL(request.url).searchParams.get("project"), {
    stableRoute,
    icons,
  });
}

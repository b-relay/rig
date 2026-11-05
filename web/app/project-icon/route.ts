import {
  faviconCache,
  faviconSource,
  iconSourceCache,
  projectIconResponse,
} from "@/server/favicon";
import { projectStatus } from "@/server/status";

const icons = faviconCache({ fetch, now: Date.now });
const sources = iconSourceCache({
  now: Date.now,
  read: async (project) => {
    const status = await projectStatus(project);
    const stable = status.ok
      ? status.value.targets.find((target) => target.kind === "stable")
      : undefined;
    return stable ? faviconSource(stable) : undefined;
  },
});

/** A Project's icon: the favicon its stable Target's Service serves on loopback, under the
 * Target's hostname, re-served from this origin; or 404 so the page shows the Project's monogram.
 * It sits behind the same admission, Content-Security-Policy and no-store as every page
 * (web/proxy.ts). */
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  return projectIconResponse(new URL(request.url).searchParams.get("project"), {
    iconSource: sources.get,
    icons,
  });
}

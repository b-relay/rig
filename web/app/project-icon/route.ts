import {
  faviconCache,
  faviconSource,
  projectIconResponse,
  type IconSource,
} from "@/server/favicon";
import { projectStatus } from "@/server/status";

const icons = faviconCache({ fetch, now: Date.now });
/** Each Project's icon source, kept a minute so a page of icons is not one status read each. */
const sources = new Map<
  string,
  { at: number; source: IconSource | undefined }
>();
async function iconSource(project: string): Promise<IconSource | undefined> {
  const hit = sources.get(project);
  if (hit && Date.now() - hit.at < 60_000) return hit.source;
  const status = await projectStatus(project);
  const stable = status.ok
    ? status.value.targets.find((target) => target.kind === "stable")
    : undefined;
  const source = stable ? faviconSource(stable) : undefined;
  sources.set(project, { at: Date.now(), source });
  return source;
}

/** A Project's icon: the favicon its stable Target's Service serves on loopback, under the
 * Target's hostname, re-served from this origin; or 404 so the page shows the Project's monogram.
 * It sits behind the same admission, Content-Security-Policy and no-store as every page
 * (web/proxy.ts). */
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  return projectIconResponse(new URL(request.url).searchParams.get("project"), {
    iconSource,
    icons,
  });
}

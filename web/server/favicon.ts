import { routeUrl } from "../lib/target";

/** A Project's icon as the site serves it from its own origin: the bytes and their image type. */
export interface Icon {
  body: Uint8Array<ArrayBuffer>;
  type: string;
}
/** Raster types only. An SVG is a document that can carry script, so it is never re-served from
 * this origin, whatever the Project's site answers. */
const IMAGE_TYPES = new Set([
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/png",
  "image/gif",
  "image/jpeg",
  "image/webp",
]);
const MAX_BYTES = 100_000;

/** Pure: where a Target's hostname keeps its favicon; nothing for a route that is no URL. */
export function faviconUrl(route: string): string | undefined {
  try {
    return `${new URL(routeUrl(route)).origin}/favicon.ico`;
  } catch {
    return undefined;
  }
}
export interface FaviconDependencies {
  fetch(url: string, init: { signal: AbortSignal }): Promise<Response>;
  now(): number;
  /** How long an answer, found or not, is kept before the site asks again. */
  ttlMs?: number;
  timeoutMs?: number;
}
/** The favicons of the Projects' published sites, fetched by the server so the page's
 * Content-Security-Policy keeps images to its own origin. Each answer (an icon or none) is kept
 * for `ttlMs`, so a site that is down costs one slow read per window, not one per page. */
export function faviconCache({
  fetch,
  now,
  ttlMs = 10 * 60_000,
  timeoutMs = 2_000,
}: FaviconDependencies) {
  const kept = new Map<string, { at: number; icon: Icon | undefined }>();
  async function read(url: string): Promise<Icon | undefined> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      const type = (response.headers.get("content-type") ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      if (!response.ok || !IMAGE_TYPES.has(type)) return undefined;
      const declared = Number(response.headers.get("content-length"));
      if (declared > MAX_BYTES) return undefined;
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength === 0 || body.byteLength > MAX_BYTES)
        return undefined;
      return { body, type };
    } catch {
      return undefined;
    }
  }
  return {
    /** The icon at `url`, from the cache while it is fresh. */
    async get(url: string): Promise<Icon | undefined> {
      const hit = kept.get(url);
      if (hit && now() - hit.at < ttlMs) return hit.icon;
      const icon = await read(url);
      kept.set(url, { at: now(), icon });
      return icon;
    },
  };
}

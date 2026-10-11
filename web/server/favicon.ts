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
  fetch(
    url: string,
    init: { signal: AbortSignal; redirect: "manual" },
  ): Promise<Response>;
  now(): number;
  /** How long an answer, found or not, is kept before the site asks again. */
  ttlMs?: number;
  timeoutMs?: number;
}
/** The body of `response` when it is at most `limit` bytes; read as a stream and abandoned the
 * moment it passes the limit, so a large answer is never buffered whole. */
async function boundedBody(
  response: Response,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(new ArrayBuffer(size));
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}
/** The favicons of the Projects' published sites, fetched by the server so the page's
 * Content-Security-Policy keeps images to its own origin. Redirects are not followed, so only the
 * host rigd records is ever asked. Each answer (an icon or none) is kept for `ttlMs`, so a site
 * that is down costs one slow read per window, not one per page. */
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
        redirect: "manual",
      });
      const type = (response.headers.get("content-type") ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      if (response.status !== 200 || !IMAGE_TYPES.has(type)) return undefined;
      const declared = Number(response.headers.get("content-length"));
      if (declared > MAX_BYTES) return undefined;
      const body = await boundedBody(response, MAX_BYTES);
      if (!body || body.byteLength === 0) return undefined;
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
export interface ProjectIconDependencies {
  /** The stable Target's hostname rigd records for `project`; nothing when it has none or rigd refused. */
  stableRoute(project: string): Promise<string | undefined>;
  icons: { get(url: string): Promise<Icon | undefined> };
}
/** The answer to `/project-icon?project=<name>`: the favicon of the Project's stable site, from the
 * hostname rigd records and never from the request, or 404 so the page keeps the monogram. */
export async function projectIconResponse(
  project: string | null,
  { stableRoute, icons }: ProjectIconDependencies,
): Promise<Response> {
  const route = project ? await stableRoute(project) : undefined;
  const url = route ? faviconUrl(route) : undefined;
  const icon = url ? await icons.get(url) : undefined;
  if (!icon) return new Response(null, { status: 404 });
  return new Response(icon.body, {
    headers: {
      "content-type": icon.type,
      "x-content-type-options": "nosniff",
    },
  });
}

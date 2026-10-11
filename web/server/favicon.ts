import { routeUrl } from "../lib/target";
import type { TargetReport } from "../lib/types";

/** A Project's icon as the site serves it from its own origin: the bytes and the image type they are. */
export interface Icon {
  body: Uint8Array<ArrayBuffer>;
  type: string;
}
/** Where a Project's favicon is read: the loopback address of the stable Target's Service that
 * serves `/`, asked for `/favicon.ico` under the Target's own hostname. The public hostname is never
 * resolved, so the dashboard never reaches into the network on a Project's behalf. */
export interface IconSource {
  /** `http://127.0.0.1:<port>/favicon.ico`. */
  url: string;
  /** The Target's hostname, sent as `Host` so the Service answers as it does for that site. */
  host: string;
}
const MAX_BYTES = 100_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

/** Pure: the favicon source of a stable Target: the port its route map sends `/` to (or, for an
 * older plan, the Service status marks as routed) on 127.0.0.1, with its hostname. Nothing without
 * a hostname or a Service behind `/`. */
export function faviconSource(
  target: Pick<TargetReport, "route" | "routes" | "components">,
): IconSource | undefined {
  if (!target.route) return undefined;
  let host: string;
  try {
    host = new URL(routeUrl(target.route)).host;
  } catch {
    return undefined;
  }
  const port =
    target.routes?.find((route) => route.prefix === "/")?.port ??
    target.components.find((component) => component.route !== undefined)?.port;
  if (port === undefined || !Number.isInteger(port) || port <= 0)
    return undefined;
  return { url: `http://127.0.0.1:${port}/favicon.ico`, host };
}
/** Pure: whether `url` is plain HTTP to this Mac's loopback, the only place an icon is read from. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname);
  } catch {
    return false;
  }
}
const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  prefix.every((byte, index) => bytes[at + index] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
/** Pure: the raster type `bytes` are by their magic numbers (PNG, ICO, JPEG, GIF, WebP), whatever a
 * server labelled them; anything else, an SVG above all, is nothing. */
export function imageType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.length > 6)
    return "image/x-icon";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a")))
    return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8))
    return "image/webp";
  return undefined;
}
export interface FaviconDependencies {
  fetch(
    url: string,
    init: {
      signal: AbortSignal;
      redirect: "manual";
      headers: { host: string };
    },
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
/** The favicons of the Projects' stable sites, read by the server from each site's loopback
 * upstream so the page's Content-Security-Policy keeps images to its own origin. A source that is
 * not loopback is refused before anything is sent; redirects are not followed; the bytes decide
 * the type. Each answer (an icon or none) is kept for `ttlMs`, so a Service that is down costs one
 * slow read per window, not one per page. */
export function faviconCache({
  fetch,
  now,
  ttlMs = 10 * 60_000,
  timeoutMs = 2_000,
}: FaviconDependencies) {
  const kept = new Map<string, { at: number; icon: Icon | undefined }>();
  async function read({ url, host }: IconSource): Promise<Icon | undefined> {
    if (!isLoopbackUrl(url)) return undefined;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
        headers: { host },
      });
      if (response.status !== 200) return undefined;
      const declared = Number(response.headers.get("content-length"));
      if (declared > MAX_BYTES) return undefined;
      const body = await boundedBody(response, MAX_BYTES);
      const type = body ? imageType(body) : undefined;
      return body && type ? { body, type } : undefined;
    } catch {
      return undefined;
    }
  }
  return {
    /** The icon at `source`, from the cache while it is fresh. */
    async get(source: IconSource): Promise<Icon | undefined> {
      const key = `${source.host} ${source.url}`;
      const hit = kept.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.icon;
      const icon = await read(source);
      kept.set(key, { at: now(), icon });
      return icon;
    },
  };
}
export interface ProjectIconDependencies {
  /** Where the Project's stable Target serves its favicon, from what rigd records; nothing when
   * it has none or rigd refused. */
  iconSource(project: string): Promise<IconSource | undefined>;
  icons: { get(source: IconSource): Promise<Icon | undefined> };
}
/** The answer to `/project-icon?project=<name>`: the favicon of the Project's stable site, from the
 * source rigd's status names and never from the request, or 404 so the page keeps the monogram. */
export async function projectIconResponse(
  project: string | null,
  { iconSource, icons }: ProjectIconDependencies,
): Promise<Response> {
  const source = project ? await iconSource(project) : undefined;
  const icon = source ? await icons.get(source) : undefined;
  if (!icon) return new Response(null, { status: 404 });
  return new Response(icon.body, {
    headers: {
      "content-type": icon.type,
      "x-content-type-options": "nosniff",
    },
  });
}

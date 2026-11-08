/** The request header through which the proxy tells the page's render which path was asked for: set on every request,
 * replacing whatever the browser sent, and read only by the server's own render. */
export const PAGE_PATH_HEADER = "x-rig-page-path";

/** Pure: the Projects whose status the page at `pathname` reads itself, which the sidebar shows as the page read them:
 * `all` for the Overview and Proxy, which read every Project, and for a path that is unknown or cannot be read; the one
 * Project of a Project's own pages and its Targets'; none elsewhere. */
export function pageReads(
  pathname: string | null | undefined,
): "all" | string[] {
  if (pathname === null || pathname === undefined) return "all";
  if (pathname === "/" || pathname === "/proxy") return "all";
  const project = /^\/projects\/([^/]+)/.exec(pathname)?.[1];
  if (project === undefined || project === "new") return [];
  try {
    return [decodeURIComponent(project)];
  } catch {
    return "all";
  }
}

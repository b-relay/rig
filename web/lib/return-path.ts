/** Pure: where a browser goes after signing in. Only a path on this site is followed, so a
 * crafted link cannot send the visitor elsewhere; anything else lands on the board. */
export function returnPath(requested: string | null | undefined): string {
  if (!requested || !requested.startsWith("/")) return "/";
  if (requested.startsWith("//") || /[\\\r\n]/.test(requested)) return "/";
  return requested;
}

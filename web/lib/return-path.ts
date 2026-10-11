/** Pure: where a browser goes after signing in. Only a path on this site is followed, so a
 * crafted link cannot send the visitor elsewhere; anything else lands on the board. */
export function returnPath(requested: string | null | undefined): string {
  if (!requested || !requested.startsWith("/")) return "/";
  // Backslashes, whitespace and control characters are refused outright: a URL parser drops tabs and newlines and
  // reads a backslash as a slash, so "/\t/evil.example" or "/\\evil.example" would otherwise become "//evil.example".
  if (/[\\\s\u0000-\u001f\u007f]/.test(requested)) return "/";
  // What is left must still name a path on this site once parsed.
  const base = "https://this.site";
  try {
    const parsed = new URL(requested, base);
    if (parsed.origin !== base) return "/";
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return "/";
  }
}

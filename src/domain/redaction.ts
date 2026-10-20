/** What stands in for a secret value in output Rig keeps or shows. */
export const REDACTED = "[redacted]";
/** A value shorter than this would match ordinary text, so it is left in place. */
const SHORTEST_REDACTED = 4;

/** `text` with every occurrence of each of `secrets`, and of each line of a multi-line one, replaced by [redacted] in one
 * pass, the longest first, so a secret that holds another is replaced whole. */
export function redactValues(text: string, secrets: readonly string[]): string {
  const pieces = [
    ...new Set(
      secrets
        .flatMap((secret) => secret.split(/\r?\n/))
        .filter((piece) => piece.trim().length >= SHORTEST_REDACTED),
    ),
  ].sort((a, b) => b.length - a.length);
  if (!pieces.length) return text;
  const pattern = new RegExp(
    pieces
      .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "g",
  );
  return text.replace(pattern, REDACTED);
}

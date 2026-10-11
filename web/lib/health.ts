import { toneOf } from "./present";

/** The only four things health says: fine, needs a look, broken, or nothing to say. */
export type Health = "green" | "orange" | "red" | "gray";

/** Pure: the health a lifecycle or outcome word reads as. A state in motion (starting, stopping)
 * needs a look until it settles; a word rigd has not taught the page says nothing. */
export function healthOf(state: string | undefined): Health {
  if (!state) return "gray";
  const tone = toneOf(state);
  if (tone === "good") return "green";
  if (tone === "bad") return "red";
  if (tone === "warn" || tone === "busy") return "orange";
  return "gray";
}
/** Pure: a group of states summed up by its least healthy member; gray when nothing runs. */
export function projectHealth(states: readonly string[]): Health {
  const health = states.map(healthOf);
  if (health.includes("red")) return "red";
  if (health.includes("orange")) return "orange";
  if (health.includes("green")) return "green";
  return "gray";
}
/** What each health says in words, for a dot's tooltip and screen readers. */
export const HEALTH_WORD: Record<Health, string> = {
  green: "healthy",
  orange: "needs attention",
  red: "failing",
  gray: "not running",
};
/** Pure: a Project's two-letter monogram, from the letters and digits of its name. */
export function monogram(name: string): string {
  return (
    name
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}
/** Pure: which of the five chart colours (1 to 5) a Project wears. Taken from its name, so the
 * same Project wears the same colour on every page. */
export function projectColor(name: string): 1 | 2 | 3 | 4 | 5 {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return ((hash % 5) + 1) as 1 | 2 | 3 | 4 | 5;
}

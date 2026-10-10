/** The colour scheme a browser chose with the theme switch; absent means it follows the system. */
export type Theme = "light" | "dark";
/** The theme switch's choice lives in a plain cookie, so the server renders the right scheme on
 * the first paint and no script has to run before it. It says nothing about who the visitor is. */
export const THEME_COOKIE = "rig_theme";
/** How long the choice is kept: a year, renewed each time the switch is used. */
export const THEME_SECONDS = 365 * 24 * 60 * 60;

/** Pure: the theme a cookie value names; anything else, absence included, follows the system. */
export function parseTheme(
  value: string | undefined | null,
): Theme | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}
/** Pure: the switch's next choice, in the order system, light, dark. */
export function nextTheme(current: Theme | undefined): Theme | undefined {
  return current === undefined
    ? "light"
    : current === "light"
      ? "dark"
      : undefined;
}
/** Pure: the Set-Cookie text for a choice; following the system again deletes the cookie. */
export function themeCookie(theme: Theme | undefined): string {
  return theme
    ? `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${THEME_SECONDS}; SameSite=Strict`
    : `${THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict`;
}

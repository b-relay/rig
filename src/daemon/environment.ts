/** Variables the daemon, managed processes, hooks, and builds may inherit from the shell that installed rigd. */
export const INHERITED_VARIABLES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
] as const;
/** Picks the login basics from a shell environment. Tokens, session ids, and Rig's own variables stay with the shell;
 * a Project adds what its processes need through envFile and env. */
export function inheritedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const name of INHERITED_VARIABLES) {
    const value = source[name];
    if (value !== undefined) inherited[name] = value;
  }
  return inherited;
}

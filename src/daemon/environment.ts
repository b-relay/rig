/** Variables the daemon and its own host tooling (git, proxy inspection) inherit from the shell that installed rigd. Applications get executionBaseline instead. */
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
 * a Project adds what its processes need through env_file and env. */
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
/** The controlled baseline beneath a Project's own env and env files: the operator's PATH and HOME and the locale/zone the shell supplied.
 * The execution adapter adds a Target-owned TMPDIR; nothing else of the daemon's environment reaches an application. */
export function executionBaseline(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const baseline: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]) {
    const value = source[name];
    if (value !== undefined) baseline[name] = value;
  }
  return baseline;
}

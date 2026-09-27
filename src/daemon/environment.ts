/** Variables the daemon and its own host tooling (git, proxy inspection) inherit from the shell that installed rigd. Applications get APPLICATION_VARIABLES through executionBaseline instead. */
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
  return pickDefined(source, INHERITED_VARIABLES);
}
/** Variables every application gets from the daemon's environment: the operator's PATH and HOME, the account name
 * as the installing shell had it (USER, LOGNAME, which Keychain lookups and getpass-style calls identify the operator by),
 * and the locale/zone the shell supplied.
 * None is a secret; tokens, session ids, SHELL, the daemon's TMPDIR, and Rig's own variables are left out. */
const APPLICATION_VARIABLES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
] as const;
/** The controlled baseline beneath a Project's own env and env files: the APPLICATION_VARIABLES the source defines.
 * The execution adapter adds a Target-owned TMPDIR; nothing else of the daemon's environment reaches an application. */
export function executionBaseline(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return pickDefined(source, APPLICATION_VARIABLES);
}
/** The named variables the source defines, with their values; an absent or undefined name is left out. */
function pickDefined(
  source: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}

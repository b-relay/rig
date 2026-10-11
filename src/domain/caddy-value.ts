import { RigError } from "./errors";

/** The kinds of value Rig writes into a generated Caddyfile, each with the one shape it may take. */
export type CaddyField =
  | "hostname"
  | "address"
  | "prefix"
  | "wildcard"
  | "upstream"
  | "path"
  | "admin"
  | "url"
  | "email"
  | "module"
  | "ip"
  | "port";

/** What each field may hold. None admits a placeholder, whitespace, a quote or a comment. */
export const CADDY_PATTERNS: Record<CaddyField, RegExp> = {
  hostname:
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/,
  wildcard: /^\*(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
  /** A site address in Rig's route file: a hostname, with an optional scheme and port. */
  address: /^(?:https?:\/\/)?[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?$/,
  /** A path prefix a route matches. */
  prefix: /^\/[A-Za-z0-9._~\/-]*$/,
  upstream: /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/,
  path: /^\/[A-Za-z0-9._@+\/-]*$/,
  admin: /^unix\/\/[A-Za-z0-9._@+\/-]+\|0600$/,
  url: /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?(?:\/[A-Za-z0-9._~%\/-]*)?$/,
  email: /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/,
  module: /^[a-z0-9_]+$/,
  ip: /^[0-9A-Fa-f:.]+$/,
  port: /^[1-9]\d{0,4}$/,
};
/** Characters no value may carry, whatever its field: Caddyfile braces (placeholders and `{$ENV}`), whitespace, quotes,
 * backslash, comments and control characters. */
const FORBIDDEN = /[{}\s"'`\\#\u0000-\u001f\u007f]/;

/** `value` when it is a well-formed `field`, unquoted; otherwise a refusal naming the field. The one gate every value
 * passes on its way into a generated Caddyfile. */
export function checkCaddyValue(
  field: CaddyField,
  value: string | number,
): string {
  const text = String(value);
  if (
    FORBIDDEN.test(text) ||
    !CADDY_PATTERNS[field].test(text) ||
    (field === "port" && Number(text) > 65535)
  )
    throw new RigError(
      field === "path" ? "PROXY_PATH" : "PROXY_CONFIG_INVALID",
      `Rig cannot write the ${field} ${JSON.stringify(text)} into Caddy's configuration.`,
      field === "path"
        ? "Use a Rig root whose path has only letters, digits and . _ @ + / -."
        : `Fix the value in the proxy section of config.yaml: a ${field} with no braces, whitespace, quotes, backslash or '#'.`,
      { field, value: text },
    );
  return text;
}
/** `value` checked by `checkCaddyValue` and written as one double-quoted Caddyfile token. */
export function caddyValue(field: CaddyField, value: string | number): string {
  return `"${checkCaddyValue(field, value)}"`;
}

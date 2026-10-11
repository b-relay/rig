/** A hostname Caddy will serve as one site: labels of letters, digits and '-', joined by dots.
 * Schemes, ports, paths, wildcards and comma lists would be rejected by Caddy at deploy time
 * or, for a catch-all, would take every request on the Host. */
export function validHostname(value: string): boolean {
  return (
    value.length <= 253 &&
    /^[a-zA-Z0-9-]{1,63}(\.[a-zA-Z0-9-]{1,63})*$/.test(value)
  );
}

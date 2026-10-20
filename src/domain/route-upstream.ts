/** The address Rig's proxy connects to for every route it publishes to a port of this Mac: a Target's routed ports and the
 * dashboard's. */
export const UPSTREAM_HOST = "127.0.0.1";

/** Pure: the upstream a route to `port` names. */
export function routeUpstream(port: number): string {
  return `${UPSTREAM_HOST}:${port}`;
}
/** Pure: the port an upstream such as `127.0.0.1:3000` names; NaN when it names none. */
export function upstreamPort(upstream: string): number {
  return Number(/:(\d+)$/.exec(upstream)?.[1] ?? Number.NaN);
}
/** Pure: whether a socket listening on `address`, as listener inspection reports it, takes the connections Rig's proxy makes
 * to UPSTREAM_HOST: bound to it, also written as an IPv4-mapped address. A listener on `::1` or another loopback address
 * does not, so another program can still bind UPSTREAM_HOST at that port and receive the route's requests. */
export function takesUpstream(address: string): boolean {
  return address === UPSTREAM_HOST || /^::ffff:127\.0\.0\.1$/i.test(address);
}

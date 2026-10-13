/** One trusted-client entry: an IPv4 block (`bits` is 32 for a single address) or one exact IPv6 address. */
export type TrustedClient =
  | { kind: "block"; base: number; bits: number }
  | { kind: "exact"; address: string };

/** Pure: an IPv4 address as a number, or undefined when `address` is not one. */
export function ipv4(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined;
    value = value * 256 + Number(part);
  }
  return value;
}
/** Pure: one trusted-client entry: an IPv4 address, an IPv4 block such as 100.64.0.0/10, or an IPv6 address. A malformed
 * entry throws rather than being skipped or widened, because a typo here decides who controls the Host. */
export function parseTrustedClient(entry: string): TrustedClient {
  const block = /^([\d.]+)\/(\d{1,2})$/.exec(entry);
  const base = ipv4(block ? block[1]! : entry);
  if (block && base !== undefined && Number(block[2]) <= 32)
    return { kind: "block", base, bits: Number(block[2]) };
  if (!block && base !== undefined) return { kind: "block", base, bits: 32 };
  if (!block && /^[0-9a-f:]+$/i.test(entry) && entry.includes(":"))
    return { kind: "exact", address: entry.toLowerCase() };
  throw new TypeError(
    `"${entry}" is not an IP address or an IPv4 block such as 100.64.0.0/10.`,
  );
}
/** Pure: a comma-separated trusted-client list, as the dashboard reads it from RIG_WEB_TRUSTED_CLIENTS. */
export function parseTrustedClients(list: string): TrustedClient[] {
  return list
    .split(",")
    .map((each) => each.trim())
    .filter(Boolean)
    .map(parseTrustedClient);
}

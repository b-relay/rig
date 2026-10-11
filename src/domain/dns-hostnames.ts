import {
  AUTOMATIC_TTL,
  zoneOf,
  type DnsRecord,
  type DnsRecordInput,
  type DnsZone,
} from "./dns-records";

/** Who serves a hostname: a Target (its domain, or a Service's) or one of the owner's own `proxy.routes`. */
export type HostnameSource =
  | {
      readonly kind: "target";
      readonly project: string;
      readonly target: string;
    }
  | { readonly kind: "route" };
/** One hostname Rig serves, with everything that serves it. */
export interface ServedHostname {
  readonly hostname: string;
  readonly sources: readonly HostnameSource[];
}
/** Whether DNS sends a hostname to this Mac:
 * - `mac`: every A record that answers for it is this Mac's address, unproxied.
 * - `elsewhere`: it answers with another address, or through the provider's proxy.
 * - `missing`: nothing answers for it with an address.
 * - `unknown`: Rig cannot tell: no visible zone holds it, a CNAME leaves those zones, or this Mac's address is unknown. */
export type HostnameVerdict = "mac" | "elsewhere" | "missing" | "unknown";
/** The one-click change that points a hostname at this Mac: a new A record, or the one A record it has, rewritten. */
export type PointFix =
  | {
      readonly op: "create";
      readonly zone: string;
      readonly record: DnsRecordInput;
      /** A wildcard that answers for the name today and that the new record takes precedence over. */
      readonly overrides?: string;
    }
  | {
      readonly op: "update";
      readonly zone: string;
      readonly id: string;
      readonly modifiedOn: string;
      readonly record: DnsRecordInput;
      /** What the record holds now. */
      readonly from: string;
    };
/** What the hostname check reports for one served hostname. */
export interface HostnameCheck {
  readonly hostname: string;
  readonly sources: readonly HostnameSource[];
  /** The zone that holds it, when a visible one does. */
  readonly zone?: string;
  readonly verdict: HostnameVerdict;
  /** The record name that answers: the hostname itself, or the wildcard that covers it. */
  readonly answeredBy?: string;
  /** Only a wildcard answers for it. */
  readonly wildcard: boolean;
  /** The CNAME hops followed, each `name -> target`. */
  readonly chain: readonly string[];
  /** The A and AAAA records the name finally resolves to. */
  readonly addresses: readonly Pick<
    DnsRecord,
    "type" | "content" | "proxied"
  >[];
  /** One sentence saying why the verdict is what it is. */
  readonly reason: string;
  /** The change "Point at this Mac" makes, when one simple change does it. */
  readonly fix?: PointFix;
  /** Why no one-click change is offered for a hostname that does not point here. */
  readonly fixBlocked?: string;
}

/** The most CNAMEs the check follows from a hostname to its address. */
export const MAX_HOPS = 8;
/** A comment Rig leaves on the A record it creates, so the owner can tell where it came from. */
export const POINT_COMMENT = "Points at this Mac; created by Rig";
type Lookup =
  | { kind: "records"; owner: string; wildcard: boolean; records: DnsRecord[] }
  | { kind: "nodata"; owner: string; parentOnly: boolean }
  | { kind: "nxdomain" };
/** Pure: what the zone's authoritative server answers for `name`, by the DNS rules for wildcards (RFC 4592): the name's own
 * records when it has any; nothing when it exists only as the parent of other names; otherwise the wildcard at its closest
 * existing ancestor, if there is one. */
export function lookupName(
  name: string,
  zone: string,
  records: readonly DnsRecord[],
): Lookup {
  const inThisZone = records.filter((record) => record.zone === zone);
  const exists = (candidate: string) =>
    inThisZone.some(
      (record) =>
        record.name === candidate || record.name.endsWith(`.${candidate}`),
    );
  const own = inThisZone.filter((record) => record.name === name);
  if (own.length)
    return { kind: "records", owner: name, wildcard: false, records: own };
  if (exists(name)) return { kind: "nodata", owner: name, parentOnly: true };
  let encloser = name.slice(name.indexOf(".") + 1);
  while (encloser !== zone && encloser.includes(".") && !exists(encloser))
    encloser = encloser.slice(encloser.indexOf(".") + 1);
  const wildcard = `*.${encloser}`;
  const covering = inThisZone.filter((record) => record.name === wildcard);
  return covering.length
    ? { kind: "records", owner: wildcard, wildcard: true, records: covering }
    : { kind: "nxdomain" };
}
/** Pure: the name at or above `name`, below the zone's apex, that NS records delegate to other nameservers; undefined when
 * none does, so the zone's own records answer for `name`. */
export function delegation(
  name: string,
  zone: string,
  records: readonly DnsRecord[],
): string | undefined {
  for (
    let candidate = name;
    candidate !== zone && candidate.endsWith(`.${zone}`);
    candidate = candidate.slice(candidate.indexOf(".") + 1)
  )
    if (
      records.some(
        (record) =>
          record.zone === zone &&
          record.name === candidate &&
          record.type === "NS",
      )
    )
      return candidate;
  return undefined;
}
/** Pure: the check of every served hostname against the provider's records. `address` is this Mac's IPv4 address, or
 * undefined when Rig does not know it; `zones` are the zones Rig manages, and `records` theirs. */
export function checkHostnames(input: {
  readonly hostnames: readonly ServedHostname[];
  readonly zones: readonly DnsZone[];
  readonly records: readonly DnsRecord[];
  readonly address: string | undefined;
  /** Zones Rig manages whose records could not be read this time; a name in one is `unknown`, never `missing`. */
  readonly unreadable?: readonly DnsZone[];
}): HostnameCheck[] {
  return [...input.hostnames]
    .sort((a, b) => a.hostname.localeCompare(b.hostname))
    .map((served) => checkHostname(served, input));
}
function checkHostname(
  served: ServedHostname,
  input: Parameters<typeof checkHostnames>[0],
): HostnameCheck {
  const { hostname } = served;
  const holder = zoneOf(hostname, [
    ...input.zones,
    ...(input.unreadable ?? []),
  ]);
  const zone = holder?.name;
  const base = {
    hostname,
    sources: served.sources,
    wildcard: false,
    chain: [],
    addresses: [],
  };
  if (!zone)
    return {
      ...base,
      verdict: "unknown",
      reason:
        "No zone Rig manages holds this name, so Rig cannot tell where it points.",
    };
  if (!input.zones.some((each) => each.name === zone))
    return {
      ...base,
      zone,
      verdict: "unknown",
      reason: `Rig could not read the records of ${zone} just now, so it cannot tell where this name points.`,
    };
  const cut = delegation(hostname, zone, input.records);
  if (cut)
    return {
      ...base,
      zone,
      verdict: "unknown",
      reason: `${cut} is delegated to other nameservers (NS records), so ${zone}'s records do not answer for this name.`,
      fixBlocked: `Point it at this Mac at the nameservers ${cut} is delegated to.`,
    };
  const chain: string[] = [];
  let name = hostname;
  let first: { owner: string; wildcard: boolean } | undefined;
  let verdict: Omit<
    HostnameCheck,
    "hostname" | "sources" | "fix" | "fixBlocked"
  >;
  for (let hop = 0; ; hop++) {
    // The zone that answers for this hop is the longest that holds the name, read or not: a parent zone's wildcard never
    // answers for a name in a child zone whose records could not be read.
    const hopZone = zoneOf(name, [
      ...input.zones,
      ...(input.unreadable ?? []),
    ])?.name;
    const where = {
      zone,
      chain,
      wildcard: first?.wildcard ?? false,
      ...(first ? { answeredBy: first.owner } : {}),
    };
    if (hopZone && !input.zones.some((each) => each.name === hopZone)) {
      verdict = {
        ...where,
        addresses: [],
        verdict: "unknown",
        reason: `It is a CNAME to ${name}, in ${hopZone}, whose records Rig could not read just now, so Rig cannot tell where that points.`,
      };
      break;
    }
    if (!hopZone) {
      verdict = {
        ...where,
        addresses: [],
        verdict: "unknown",
        reason: `It is a CNAME to ${name}, outside the zones Rig manages, so Rig cannot tell where that points.`,
      };
      break;
    }
    const hopCut =
      hop > 0 ? delegation(name, hopZone, input.records) : undefined;
    if (hopCut) {
      verdict = {
        ...where,
        addresses: [],
        verdict: "unknown",
        reason: `It is a CNAME to ${name}, which ${hopCut} delegates to other nameservers, so Rig cannot tell where that points.`,
      };
      break;
    }
    const found = lookupName(name, hopZone, input.records);
    if (found.kind !== "records") {
      const dangling = hop > 0 ? `Its CNAME leads to ${name}, which ` : "It ";
      verdict = {
        ...where,
        addresses: [],
        verdict: "missing",
        reason:
          found.kind === "nxdomain"
            ? `${hop > 0 ? `Its CNAME leads to ${name}, which has` : "It has"} no record, and no wildcard covers it.`
            : found.parentOnly
              ? `${dangling}exists only as the parent of other records, so no wildcard answers for it and it has no address.`
              : `${dangling}has records, but no A record.`,
      };
      break;
    }
    first ??= { owner: found.owner, wildcard: found.wildcard };
    const cname = found.records.find((record) => record.type === "CNAME");
    if (cname) {
      chain.push(
        `${found.owner} -> ${cname.content}${cname.proxied ? " (proxied)" : ""}`,
      );
      if (cname.proxied) {
        verdict = {
          zone,
          chain,
          wildcard: first.wildcard,
          answeredBy: first.owner,
          addresses: [],
          verdict: "elsewhere",
          reason:
            "Its CNAME is proxied through Cloudflare, whose edge cannot reach this Mac's Tailscale address.",
        };
        break;
      }
      // The record at each hop is examined first, so a chain of exactly MAX_HOPS CNAMEs still reaches its address; only
      // a CNAME beyond them (a longer chain, or a loop) stops the walk.
      if (chain.length > MAX_HOPS) {
        verdict = {
          zone,
          chain,
          wildcard: first.wildcard,
          answeredBy: first.owner,
          addresses: [],
          verdict: "unknown",
          reason: `Its CNAME chain is longer than ${MAX_HOPS} hops or loops.`,
        };
        break;
      }
      name = cname.content;
      continue;
    }
    const addresses = found.records
      .filter((record) => record.type === "A" || record.type === "AAAA")
      .map((record) => ({
        type: record.type,
        content: record.content,
        ...(record.proxied ? { proxied: true } : {}),
      }));
    const resolved = {
      zone,
      chain,
      wildcard: first.wildcard,
      answeredBy: first.owner,
      addresses,
    };
    verdict = {
      ...resolved,
      ...judge(addresses, input.address, first, hop > 0),
    };
    break;
  }
  return {
    hostname,
    sources: served.sources,
    ...verdict,
    ...pointFix(hostname, zone, verdict, input),
  };
}
/** Pure: the verdict on the addresses a name resolves to. */
function judge(
  addresses: readonly Pick<DnsRecord, "type" | "content" | "proxied">[],
  address: string | undefined,
  answer: { owner: string; wildcard: boolean },
  viaCname: boolean,
): { verdict: HostnameVerdict; reason: string } {
  const a = addresses.filter((record) => record.type === "A");
  const by = answer.wildcard
    ? `The wildcard ${answer.owner}`
    : viaCname
      ? "Its CNAME chain"
      : "It";
  if (!addresses.length)
    return {
      verdict: "missing",
      reason: `${by} has records, but no A record.`,
    };
  if (!a.length)
    return {
      verdict: "elsewhere",
      reason: `${by} has only AAAA records; this Mac is reached by its IPv4 address.`,
    };
  if (a.some((record) => record.proxied))
    return {
      verdict: "elsewhere",
      reason: `${by} is proxied through Cloudflare, whose edge cannot reach this Mac's Tailscale address.`,
    };
  const contents = [...new Set(a.map((record) => record.content))];
  if (!address)
    return {
      verdict: "unknown",
      reason: `${by} points at ${contents.join(", ")}. Rig does not know this Mac's address: set proxy.dns.address, or install Tailscale.`,
    };
  const v6 =
    addresses.length > a.length ? " Its AAAA records are not checked." : "";
  if (contents.every((content) => content === address))
    return {
      verdict: "mac",
      reason: answer.wildcard
        ? `Covered only by the wildcard ${answer.owner}, which points at this Mac.${v6}`
        : `Points at this Mac.${v6}`,
    };
  return {
    verdict: "elsewhere",
    reason: `${by} points at ${contents.join(", ")}, not this Mac (${address}).${v6}`,
  };
}
/** Pure: the one change that would point `hostname` at this Mac, or why none is offered. */
function pointFix(
  hostname: string,
  zone: string,
  verdict: { verdict: HostnameVerdict; answeredBy?: string; wildcard: boolean },
  input: Parameters<typeof checkHostnames>[0],
): Pick<HostnameCheck, "fix" | "fixBlocked"> {
  if (verdict.verdict === "mac") return {};
  const address = input.address;
  if (!address)
    return {
      fixBlocked:
        "Rig does not know this Mac's address: set proxy.dns.address in config.yaml, or install Tailscale.",
    };
  const own = input.records.filter(
    (record) => record.zone === zone && record.name === hostname,
  );
  const cname = own.find((record) => record.type === "CNAME");
  if (cname)
    return {
      fixBlocked: `${hostname} is a CNAME to ${cname.content}; edit or delete that record to point the name at this Mac.`,
    };
  const a = own.filter((record) => record.type === "A");
  if (a.length > 1)
    return {
      fixBlocked: `${hostname} has ${a.length} A records; edit or delete them in the records below.`,
    };
  if (a.length === 1) {
    const record = a[0]!;
    return {
      fix: {
        op: "update",
        zone,
        id: record.id,
        modifiedOn: record.modifiedOn,
        from: `${record.content}${record.proxied ? " (proxied)" : ""}`,
        record: {
          name: hostname,
          type: "A",
          content: address,
          ttl: record.ttl,
          proxied: false,
          ...(record.comment ? { comment: record.comment } : {}),
        },
      },
    };
  }
  return {
    fix: {
      op: "create",
      zone,
      record: {
        name: hostname,
        type: "A",
        content: address,
        ttl: AUTOMATIC_TTL,
        proxied: false,
        comment: POINT_COMMENT,
      },
      ...(verdict.wildcard && verdict.answeredBy
        ? { overrides: verdict.answeredBy }
        : {}),
    },
  };
}

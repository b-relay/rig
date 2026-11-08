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
 * - `mac`: every A record that answers for it is this Mac's address, and no address record at that name is proxied.
 * - `elsewhere`: it answers with another address, or through the provider's proxy: Cloudflare proxies all of a name's A and
 *   AAAA records when any one of them is.
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
  /** The zone whose records could not be read, when that is why the verdict is `unknown`. */
  readonly unreadZone?: string;
}

/** The most CNAMEs the check follows from a hostname to its address. */
export const MAX_HOPS = 8;
/** A comment Rig leaves on the A record it creates, so the owner can tell where it came from. */
export const POINT_COMMENT = "Points at this Mac; created by Rig";
type Lookup =
  | { kind: "records"; owner: string; wildcard: boolean; records: DnsRecord[] }
  | { kind: "nodata"; owner: string }
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
  if (exists(name)) return { kind: "nodata", owner: name };
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
  /** Zones Rig manages whose records are not in `records`, unreadable or not read this time; a name in one is `unknown`, never
   * `missing`. */
  readonly unreadable?: readonly DnsZone[];
}): HostnameCheck[] {
  const view = {
    zones: input.zones,
    records: input.records,
    unreadable: input.unreadable ?? [],
  };
  return [...input.hostnames]
    .sort((a, b) => a.hostname.localeCompare(b.hostname))
    .map((served) => checkHostname(served, view, input.address));
}
/** The managed zones as one check sees them: those whose records it has, those records, and those it could not read. */
export interface ZoneRecords {
  readonly zones: readonly DnsZone[];
  readonly records: readonly DnsRecord[];
  readonly unreadable: readonly DnsZone[];
}
type Address = Pick<DnsRecord, "type" | "content" | "proxied">;
type Answered = Extract<Lookup, { kind: "records" }>;
type Unanswered = Exclude<Lookup, { kind: "records" }>;
/** The record name that first answers for a hostname: its own, or the wildcard that covers it. */
export interface FirstAnswer {
  readonly owner: string;
  readonly wildcard: boolean;
}
/** Where the walk from a hostname along its CNAMEs ends: nothing answers for the hostname itself, or `first` does and the
 * walk ends after the hops in `chain`. */
export type Resolution =
  | { readonly kind: "unanswered"; readonly lookup: Unanswered }
  | {
      readonly kind: "answered";
      readonly first: FirstAnswer;
      /** The CNAME hops followed, each `name -> target`. */
      readonly chain: readonly string[];
      readonly end: ChainEnd;
    };
/** The name an answered walk stopped at, or why it stopped before one. */
export type ChainEnd =
  /** A name with no CNAME: its A and AAAA records. */
  | { readonly kind: "addresses"; readonly addresses: readonly Address[] }
  /** A CNAME to a name nothing answers for. */
  | {
      readonly kind: "dangling";
      readonly name: string;
      readonly lookup: Unanswered;
    }
  /** A CNAME to a name in a managed zone whose records were not read. */
  | { readonly kind: "unread"; readonly name: string; readonly zone: string }
  /** A CNAME to a name no managed zone holds. */
  | { readonly kind: "outside"; readonly name: string }
  /** A CNAME to a name that `cut`'s NS records delegate to other nameservers. */
  | { readonly kind: "delegated"; readonly name: string; readonly cut: string }
  | { readonly kind: "proxied-cname" }
  /** More than MAX_HOPS CNAMEs, or a loop. */
  | { readonly kind: "too-long" };
/** What the check reports when no zone's records answer for a hostname. */
type ZoneRefusal = Pick<
  HostnameCheck,
  "zone" | "verdict" | "unreadZone" | "reason" | "fixBlocked"
>;
/** Pure: the zone whose records answer for `hostname`, or why none does: no managed zone holds it, its zone's records were
 * not read, or NS records below the apex delegate it. */
export function answeringZone(
  hostname: string,
  view: ZoneRecords,
): { readonly zone: string } | { readonly refusal: ZoneRefusal } {
  const zone = zoneOf(hostname, [...view.zones, ...view.unreadable])?.name;
  if (!zone)
    return {
      refusal: {
        verdict: "unknown",
        reason:
          "No zone Rig manages holds this name, so Rig cannot tell where it points.",
      },
    };
  if (!view.zones.some((each) => each.name === zone))
    return {
      refusal: {
        zone,
        verdict: "unknown",
        unreadZone: zone,
        reason: `Rig could not read the records of ${zone} just now, so it cannot tell where this name points.`,
      },
    };
  const cut = delegation(hostname, zone, view.records);
  if (cut)
    return {
      refusal: {
        zone,
        verdict: "unknown",
        reason: `${cut} is delegated to other nameservers (NS records), so ${zone}'s records do not answer for this name.`,
        fixBlocked: `Point it at this Mac at the nameservers ${cut} is delegated to.`,
      },
    };
  return { zone };
}
/** Pure: the walk from `hostname` along its CNAMEs, starting in `zone`, the zone answeringZone found to answer for it. */
export function resolveChain(
  hostname: string,
  zone: string,
  view: ZoneRecords,
): Resolution {
  const found = lookupName(hostname, zone, view.records);
  if (found.kind !== "records") return { kind: "unanswered", lookup: found };
  const first = { owner: found.owner, wildcard: found.wildcard };
  const chain: string[] = [];
  const ends = (end: ChainEnd): Resolution => ({
    kind: "answered",
    first,
    chain,
    end,
  });
  for (let answer: Answered = found; ;) {
    const cname = answer.records.find((record) => record.type === "CNAME");
    if (!cname)
      return ends({ kind: "addresses", addresses: addressesOf(answer) });
    chain.push(
      `${answer.owner} -> ${cname.content}${cname.proxied ? " (proxied)" : ""}`,
    );
    if (cname.proxied) return ends({ kind: "proxied-cname" });
    // The record at each hop is examined first, so a chain of exactly MAX_HOPS CNAMEs still reaches its address; only a
    // CNAME beyond them (a longer chain, or a loop) stops the walk.
    if (chain.length > MAX_HOPS) return ends({ kind: "too-long" });
    const name = cname.content;
    // The zone that answers for this hop is the longest that holds the name, read or not: a parent zone's wildcard never
    // answers for a name in a child zone whose records could not be read.
    const hopZone = zoneOf(name, [...view.zones, ...view.unreadable])?.name;
    if (!hopZone) return ends({ kind: "outside", name });
    if (!view.zones.some((each) => each.name === hopZone))
      return ends({ kind: "unread", name, zone: hopZone });
    const cut = delegation(name, hopZone, view.records);
    if (cut) return ends({ kind: "delegated", name, cut });
    const next = lookupName(name, hopZone, view.records);
    if (next.kind !== "records")
      return ends({ kind: "dangling", name, lookup: next });
    answer = next;
  }
}
function addressesOf(answer: Answered): Address[] {
  return answer.records
    .filter((record) => record.type === "A" || record.type === "AAAA")
    .map((record) => ({
      type: record.type,
      content: record.content,
      ...(record.proxied ? { proxied: true } : {}),
    }));
}
/** Pure: the verdict on where a hostname's walk ends, with the addresses it reached and the sentence that says why.
 * `address` is this Mac's, or undefined when Rig does not know it. */
export function verdictOf(
  resolution: Resolution,
  address: string | undefined,
): Pick<HostnameCheck, "addresses" | "verdict" | "unreadZone" | "reason"> {
  if (resolution.kind === "unanswered")
    return {
      addresses: [],
      verdict: "missing",
      reason: unansweredReason("It", resolution.lookup),
    };
  const { end } = resolution;
  switch (end.kind) {
    case "addresses":
      return {
        addresses: end.addresses,
        ...judge(
          end.addresses,
          address,
          resolution.first,
          resolution.chain.length > 0,
        ),
      };
    case "dangling":
      return {
        addresses: [],
        verdict: "missing",
        reason: unansweredReason(
          `Its CNAME leads to ${end.name}, which`,
          end.lookup,
        ),
      };
    case "unread":
      return {
        addresses: [],
        verdict: "unknown",
        unreadZone: end.zone,
        reason: `It is a CNAME to ${end.name}, in ${end.zone}, whose records Rig could not read just now, so Rig cannot tell where that points.`,
      };
    case "outside":
      return {
        addresses: [],
        verdict: "unknown",
        reason: `It is a CNAME to ${end.name}, outside the zones Rig manages, so Rig cannot tell where that points.`,
      };
    case "delegated":
      return {
        addresses: [],
        verdict: "unknown",
        reason: `It is a CNAME to ${end.name}, which ${end.cut} delegates to other nameservers, so Rig cannot tell where that points.`,
      };
    case "proxied-cname":
      return {
        addresses: [],
        verdict: "elsewhere",
        reason:
          "Its CNAME is proxied through Cloudflare, whose edge cannot reach this Mac's Tailscale address.",
      };
    case "too-long":
      return {
        addresses: [],
        verdict: "unknown",
        reason: `Its CNAME chain is longer than ${MAX_HOPS} hops or loops.`,
      };
  }
}
/** Why a name nothing answers for has no address; `subject` names it: "It", or the CNAME that leads to it. */
function unansweredReason(subject: string, lookup: Unanswered): string {
  if (lookup.kind === "nxdomain")
    return `${subject} has no record, and no wildcard covers it.`;
  return `${subject} exists only as the parent of other records, so no wildcard answers for it and it has no address.`;
}
function checkHostname(
  served: ServedHostname,
  view: ZoneRecords,
  address: string | undefined,
): HostnameCheck {
  const { hostname, sources } = served;
  const holder = answeringZone(hostname, view);
  if ("refusal" in holder)
    return {
      hostname,
      sources,
      wildcard: false,
      chain: [],
      addresses: [],
      ...holder.refusal,
    };
  const { zone } = holder;
  const resolution = resolveChain(hostname, zone, view);
  const first = resolution.kind === "answered" ? resolution.first : undefined;
  const report = {
    zone,
    chain: resolution.kind === "answered" ? resolution.chain : [],
    wildcard: first?.wildcard ?? false,
    ...(first ? { answeredBy: first.owner } : {}),
    ...verdictOf(resolution, address),
  };
  return {
    hostname,
    sources,
    ...report,
    ...pointFix(
      {
        hostname,
        zone,
        verdict: report.verdict,
        own: view.records.filter(
          (record) => record.zone === zone && record.name === hostname,
        ),
        ...(first?.wildcard ? { overrides: first.owner } : {}),
      },
      address,
    ),
  };
}
/** Pure: the verdict on the addresses a name resolves to. */
function judge(
  addresses: readonly Address[],
  address: string | undefined,
  answer: FirstAnswer,
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
  if (a.some((record) => record.proxied))
    return {
      verdict: "elsewhere",
      reason: `${by} is proxied through Cloudflare, whose edge cannot reach this Mac's Tailscale address.`,
    };
  if (addresses.some((record) => record.proxied))
    return {
      verdict: "elsewhere",
      reason: `${by} has a proxied AAAA record, so Cloudflare answers for all its addresses from its edge, which cannot reach this Mac's Tailscale address.`,
    };
  if (!a.length)
    return {
      verdict: "elsewhere",
      reason: `${by} has only AAAA records; this Mac is reached by its IPv4 address.`,
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
/** Pure: the one change that would point `name.hostname` at this Mac (`address`), or why none is offered. `own` are the
 * records of that exact name in `zone`, and `overrides` the wildcard that alone answers for it today, if one does. */
export function pointFix(
  name: {
    readonly hostname: string;
    readonly zone: string;
    readonly verdict: HostnameVerdict;
    readonly own: readonly DnsRecord[];
    readonly overrides?: string;
  },
  address: string | undefined,
): Pick<HostnameCheck, "fix" | "fixBlocked"> {
  const { hostname, zone, own } = name;
  if (name.verdict === "mac") return {};
  if (!address)
    return {
      fixBlocked:
        "Rig does not know this Mac's address: set proxy.dns.address in config.yaml, or install Tailscale.",
    };
  const cname = own.find((record) => record.type === "CNAME");
  if (cname)
    return {
      fixBlocked: `${hostname} is a CNAME to ${cname.content}; edit or delete that record to point the name at this Mac.`,
    };
  // Its own A record would stay behind the edge beside this. A wildcard's does not matter: the name's own record replaces it.
  if (own.some((record) => record.type === "AAAA" && record.proxied))
    return {
      fixBlocked: `${hostname} has a proxied AAAA record, which keeps the whole name behind Cloudflare's edge: make it DNS only or delete it, and its A record can then point here.`,
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
      ...(name.overrides ? { overrides: name.overrides } : {}),
    },
  };
}

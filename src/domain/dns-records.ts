import { z } from "zod";

/** The record types Rig manages (ADR 0018). A zone may hold others (NS, SRV, HTTPS…); Rig lists them read-only. */
export const DNS_RECORD_TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "TXT",
  "MX",
  "CAA",
] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];
/** Types whose traffic a DNS provider can proxy through its own edge (Cloudflare's orange cloud). */
export const PROXIABLE_TYPES: readonly DnsRecordType[] = ["A", "AAAA", "CNAME"];
/** TTL 1 asks the provider to choose ("Auto" in Cloudflare); otherwise seconds from 60 to one day. */
export const AUTOMATIC_TTL = 1;
/** Cloudflare's limit on one TXT record's content. */
export const TXT_MAX = 2048;
/** The longest record comment any Cloudflare plan keeps (Free keeps 100; Cloudflare refuses a longer one there with its own
 * reason). Rig never refuses a comment Cloudflare stored, so an edit of such a record never fails on it. */
export const COMMENT_MAX = 500;
/** The shortest TTL Cloudflare allows; zones below Enterprise start at 60 and Cloudflare refuses less there itself. */
export const MIN_TTL = 30;

/** A zone the provider's token can see: a registered domain whose records Rig can list and change. */
export interface DnsZone {
  /** The provider's id for the zone. */
  readonly id: string;
  /** The zone's apex name, lowercase, such as example.com. */
  readonly name: string;
  /** The provider's word for the zone's state, such as active or pending. */
  readonly status: string;
}
/** One record as the provider stores it. */
export interface DnsRecord {
  /** The provider's id for the record. */
  readonly id: string;
  /** The name of the zone it belongs to. */
  readonly zone: string;
  /** Fully qualified, lowercase, without a trailing dot; a wildcard starts with `*.`. */
  readonly name: string;
  /** One of DNS_RECORD_TYPES, or another type Rig only lists. */
  readonly type: string;
  readonly content: string;
  /** Seconds; AUTOMATIC_TTL means the provider's choice. */
  readonly ttl: number;
  /** Answered by the provider's proxy edge rather than with `content`; only A, AAAA and CNAME can be. */
  readonly proxied?: boolean;
  /** MX preference; lower is preferred. */
  readonly priority?: number;
  readonly comment?: string;
  /** When the provider last changed it (ISO 8601); a write that read this value is refused once it differs. */
  readonly modifiedOn: string;
}
/** What a create or an update asks for. The name is fully qualified within its zone. */
export interface DnsRecordInput {
  readonly name: string;
  readonly type: DnsRecordType;
  readonly content: string;
  readonly ttl: number;
  readonly proxied?: boolean;
  readonly priority?: number;
  readonly comment?: string;
}

const LABEL = /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)$/;
/** Pure: whether `name` is a record name Rig accepts: lowercase labels of letters, digits, '-' and '_' (for names such as
 * _dmarc), at most 63 bytes each and 253 in all; the first label may be `*`, a wildcard. */
export function validRecordName(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false;
  const labels = name.split(".");
  if (labels.length < 2) return false;
  return labels.every((label, index) =>
    index === 0 && label === "*" ? true : LABEL.test(label),
  );
}
/** Pure: whether `name` is a host a CNAME or MX may point at: a record name without a wildcard. */
export function validTargetHost(name: string): boolean {
  return !name.includes("*") && validRecordName(name);
}
/** Pure: `name` as a record name: lowercase, without a trailing dot. */
export function canonicalName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}
/** Pure: whether `name` is `zone` itself or a name below it. */
export function inZone(name: string, zone: string): boolean {
  return name === zone || name.endsWith(`.${zone}`);
}
/** Pure: the zone `name` belongs to: the longest zone name it is in, or undefined. */
export function zoneOf<T extends { readonly name: string }>(
  name: string,
  zones: readonly T[],
): T | undefined {
  return zones
    .filter((zone) => inZone(name, zone.name))
    .sort((a, b) => b.name.length - a.name.length)[0];
}
/** Pure: a name as the owner typed it, made fully qualified in `zone`: `@` is the apex, a name already in the zone is kept,
 * and anything else is relative to the zone. */
export function qualifyName(name: string, zone: string): string {
  const typed = canonicalName(name);
  if (typed === "@" || typed === "") return zone;
  return inZone(typed, zone) ? typed : `${typed}.${zone}`;
}
/** Pure: a TXT record's value as a resolver assembles it. Cloudflare documents TXT content as RFC 1035 quoted
 * character-strings of up to 255 bytes each, splits a longer value into several (`"part1" "part2"`), and returns the
 * content as stored, quoted or not. So a fully quoted content is its strings joined with nothing between, with `\"`, `\\`
 * and `\DDD` unescaped; anything else is the text itself. */
export function txtValue(content: string): string {
  const text = content.trim();
  const string = /"((?:[^"\\]|\\.)*)"/g;
  if (!/^"(?:[^"\\]|\\.)*"(?:\s+"(?:[^"\\]|\\.)*")*$/.test(text)) return text;
  return [...text.matchAll(string)]
    .map((part) =>
      part[1]!.replace(/\\(\d{3}|.)/g, (_, escaped: string) =>
        escaped.length === 3 ? String.fromCharCode(Number(escaped)) : escaped,
      ),
    )
    .join("");
}
/** Pure: whether two contents of a record type say the same: hostnames without case or a trailing dot, TXT values as
 * resolvers assemble them (see `txtValue`), anything else as written. */
export function sameContent(type: string, a: string, b: string): boolean {
  return contentKey(type, a) === contentKey(type, b);
}
/** Pure: content in the one form two equivalent contents of `type` share, as Cloudflare normalizes what it stores:
 * hostnames lowercase without a trailing dot, TXT as assembled, IPv4 and IPv6 canonical (RFC 5952: lowercase, leading
 * zeros dropped, the longest run of zero groups as `::`), CAA as flags, lowercase tag and the unquoted value exactly as
 * written. Content that does not parse as its type is compared as written. */
export function contentKey(type: string, content: string): string {
  const text = content.trim();
  switch (type) {
    case "CNAME":
    case "MX":
      return canonicalName(text);
    case "TXT":
      return txtValue(text);
    case "A":
      return /^\d{1,3}(\.\d{1,3}){3}$/.test(text)
        ? text
            .split(".")
            .map((part) => String(Number(part)))
            .join(".")
        : text;
    case "AAAA":
      return canonicalIpv6(text) ?? text.toLowerCase();
    case "CAA": {
      // Only the separators between fields are normalized; the value keeps its exact characters (RFC 8659 4.2), so a
      // nonbreaking space and an ordinary one in a value stay different.
      const match =
        /^(\d{1,3})[ \t]+([A-Za-z0-9]+)[ \t]+(?:"((?:[^"\\]|\\.)*)"|([^ \t]+))$/.exec(
          text,
        );
      return match
        ? `${Number(match[1])} ${match[2]!.toLowerCase()} ${match[3] ?? match[4]}`
        : text;
    }
    default:
      return text;
  }
}
/** Pure: an IPv6 address in RFC 5952's canonical text, or undefined when it is not one. An embedded IPv4 tail is kept as
 * two groups. */
export function canonicalIpv6(address: string): string | undefined {
  if (!z.ipv6().safeParse(address).success) return undefined;
  let text = address.toLowerCase();
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::")
    ? text.split("::")
    : [text, undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8) return undefined;
  const words = groups.map((group) => parseInt(group, 16).toString(16));
  // The longest run of two or more zero groups, the first when tied, becomes "::".
  let best = { start: -1, length: 0 };
  for (let start = 0; start < 8; start++) {
    let length = 0;
    while (start + length < 8 && words[start + length] === "0") length++;
    if (length > best.length) best = { start, length };
  }
  if (best.length < 2) return words.join(":");
  return `${words.slice(0, best.start).join(":")}::${words.slice(best.start + best.length).join(":")}`;
}
/** Pure: the parts of CAA content: `<flags> <tag> "<value>"`. */
export function caaParts(
  content: string,
): { flags: number; tag: string; value: string } | undefined {
  const match =
    /^(\d{1,3})\s+(issue|issuewild|iodef)\s+"([^"\\\u0000-\u001f]*)"$/.exec(
      content.trim(),
    );
  if (!match || Number(match[1]) > 255) return undefined;
  return { flags: Number(match[1]), tag: match[2]!, value: match[3]! };
}
const PRINTABLE = /^[^\u0000-\u001f\u007f]*$/;

/** A create or update as the control plane carries it, checked field by field and against its type's content rules. */
export const dnsRecordInputSchema = z
  .strictObject({
    name: z
      .string()
      .max(253)
      .refine(
        (name) => validRecordName(name),
        "must be a fully qualified lowercase name such as app.example.com; letters, digits, '-' and '_', with an optional leading '*.'",
      )
      .describe(
        "Fully qualified record name, lowercase, without a trailing dot, such as app.example.com or *.example.com.",
      ),
    type: z
      .enum(DNS_RECORD_TYPES)
      .describe("Record type: A, AAAA, CNAME, TXT, MX or CAA."),
    content: z
      .string()
      .min(1)
      .max(TXT_MAX)
      .describe(
        'A: an IPv4 address. AAAA: an IPv6 address. CNAME and MX: a hostname. TXT: text up to 2048 characters. CAA: <flags> <tag> "<value>", such as 0 issue "letsencrypt.org".',
      ),
    ttl: z
      .number()
      .int()
      .refine(
        (ttl) => ttl === AUTOMATIC_TTL || (ttl >= MIN_TTL && ttl <= 86400),
        "must be 1 (automatic) or from 30 to 86400 seconds",
      )
      .describe(
        "Seconds resolvers may cache the answer: 1 for automatic, or 30 (Enterprise; 60 otherwise) to 86400.",
      ),
    proxied: z
      .boolean()
      .optional()
      .describe(
        "A, AAAA and CNAME only: answer through Cloudflare's proxy instead of with the content. A proxied name cannot reach a Tailscale address.",
      ),
    priority: z
      .number()
      .int()
      .min(0)
      .max(65535)
      .optional()
      .describe("MX only, and required there: the preference, lower first."),
    comment: z
      .string()
      .max(COMMENT_MAX)
      .regex(PRINTABLE, "must be one line of printable text")
      .optional()
      .describe(
        "A note kept with the record at the provider: up to 100 characters on Cloudflare's Free plan, 500 on paid plans.",
      ),
  })
  .superRefine((record, context) => {
    const issue = (path: string, message: string) =>
      context.addIssue({ code: "custom", path: [path], message });
    const content = record.content;
    switch (record.type) {
      case "A":
        if (!z.ipv4().safeParse(content).success)
          issue("content", "must be an IPv4 address such as 100.64.0.1");
        break;
      case "AAAA":
        if (!z.ipv6().safeParse(content).success)
          issue("content", "must be an IPv6 address such as fd7a:115c:a1e0::1");
        break;
      case "CNAME":
      case "MX":
        if (!validTargetHost(canonicalName(content)))
          issue("content", "must be a hostname such as app.example.com");
        else if (
          record.type === "CNAME" &&
          canonicalName(content) === record.name
        )
          issue("content", "must not point at the record's own name");
        break;
      case "TXT":
        if (!PRINTABLE.test(content))
          issue("content", "must be printable text without line breaks");
        break;
      case "CAA":
        if (!caaParts(content))
          issue(
            "content",
            'must be <flags> <tag> "<value>", such as 0 issue "letsencrypt.org", with tag issue, issuewild or iodef',
          );
        break;
    }
    if (record.proxied && !PROXIABLE_TYPES.includes(record.type))
      issue("proxied", "only A, AAAA and CNAME records can be proxied");
    if (record.type === "MX" && record.priority === undefined)
      issue("priority", "an MX record needs a priority, such as 10");
    if (record.type !== "MX" && record.priority !== undefined)
      issue("priority", "only MX records have a priority");
  });

/** Pure: `record` as its write request carries it: names and hostnames canonical, and no field its type does not use. */
export function normalizeRecordInput(record: DnsRecordInput): DnsRecordInput {
  const hostContent = record.type === "CNAME" || record.type === "MX";
  return {
    name: canonicalName(record.name),
    type: record.type,
    content: hostContent
      ? canonicalName(record.content)
      : record.content.trim(),
    ttl: record.ttl,
    ...(PROXIABLE_TYPES.includes(record.type)
      ? { proxied: record.proxied === true }
      : {}),
    ...(record.type === "MX" ? { priority: record.priority } : {}),
    ...(record.comment ? { comment: record.comment } : {}),
  };
}
/** DNS refusals that are the request's own mistake (a malformed or stale request, a zone Rig does not manage), refused
 * before anything is written and, like other commands' usage mistakes, not recorded as failed Operations. */
export const DNS_REFUSALS: ReadonlySet<string> = new Set([
  "DNS_RECORD",
  "DNS_CHANGED",
  "DNS_REQUEST",
  "DNS_ZONE",
  "DNS_CONFIRMATION",
]);
/** Pure: the change a DNS write asks for, in Activity's words, before rigd has read the record it names:
 * `create A app.example.com`, or `delete record <id>`. */
export function requestedDnsChange(
  action: "dns-create" | "dns-update" | "dns-delete",
  request: { record?: { type: string; name: string }; id?: string },
): string {
  const verb = action.slice(4);
  return request.record
    ? `${verb} ${request.record.type} ${request.record.name}`
    : `${verb} record ${request.id ?? "(none named)"}`;
}
/** Pure: one line naming a record for Activity and confirmations: its type and name, and the address or host it points at.
 * Never anything from the provider's credentials. */
export function describeRecord(
  record: Pick<DnsRecord, "type" | "name" | "content" | "proxied">,
): string {
  const points = ["A", "AAAA", "CNAME", "MX"].includes(record.type);
  return `${record.type} ${record.name}${points ? ` -> ${record.content}` : ""}${record.proxied ? " (proxied)" : ""}`;
}
/** Pure: the records at `name` of `type`. */
export function recordsAt(
  records: readonly DnsRecord[],
  name: string,
  type: string,
): DnsRecord[] {
  return records.filter(
    (record) => record.name === name && record.type === type,
  );
}
/** Pure: what `create` would collide with, for a create that expects the name to have no such record yet: any record of the
 * same type at the name, or a CNAME there, or for a CNAME any record there. Cloudflare refuses some of these itself; the rest
 * would silently add a second answer. */
export function createConflicts(
  records: readonly DnsRecord[],
  create: Pick<DnsRecordInput, "name" | "type">,
): DnsRecord[] {
  return records.filter(
    (record) =>
      record.name === create.name &&
      (record.type === create.type ||
        record.type === "CNAME" ||
        create.type === "CNAME"),
  );
}

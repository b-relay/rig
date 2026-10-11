import {
  AUTOMATIC_TTL,
  DNS_RECORD_TYPES,
  PROXIABLE_TYPES,
  dnsRecordInputSchema,
  normalizeRecordInput,
  qualifyName,
} from "../../src/domain/dns-records";
import type { Health } from "./health";
import type { Failure } from "./outcome";
import type {
  DnsRecord,
  DnsRecordInput,
  DnsRecordType,
  HostnameCheck,
  HostnameSource,
  PointFix,
  RuntimeCommand,
} from "./types";

/* The DNS section of the Proxy page reads through this module (ADR 0018). rigd reads the provider's token and
 * answers with the records and the hostname check; every change goes back through rigd as a dns-create,
 * dns-update or dns-delete command carrying what the page read, so rigd refuses it if the record changed since. */

export { DNS_RECORD_TYPES, PROXIABLE_TYPES };
/** Each verdict as a word and a health. */
export const VERDICT: Record<
  HostnameCheck["verdict"],
  { word: string; health: Health }
> = {
  mac: { word: "this Mac", health: "green" },
  elsewhere: { word: "elsewhere", health: "orange" },
  missing: { word: "no record", health: "red" },
  unknown: { word: "unknown", health: "gray" },
};
/** Pure: a TTL as Cloudflare's dashboard says it. */
export function ttlLabel(ttl: number): string {
  if (ttl === AUTOMATIC_TTL) return "Auto";
  if (ttl % 86400 === 0) return `${ttl / 86400} d`;
  if (ttl % 3600 === 0) return `${ttl / 3600} h`;
  if (ttl % 60 === 0) return `${ttl / 60} min`;
  return `${ttl} s`;
}
/** The TTLs the record dialog offers, as Cloudflare's dashboard does. */
export const TTL_CHOICES: readonly number[] = [
  AUTOMATIC_TTL,
  60,
  120,
  300,
  600,
  1800,
  3600,
  7200,
  18000,
  43200,
  86400,
];
/** Pure: whether Rig edits records of this type; others are listed only. */
export function editable(record: Pick<DnsRecord, "type">): boolean {
  return (DNS_RECORD_TYPES as readonly string[]).includes(record.type);
}
/** Pure: a record name as the owner types it in its zone: `@` for the zone itself, otherwise without the zone. */
export function relativeName(name: string, zone: string): string {
  if (name === zone) return "@";
  return name.endsWith(`.${zone}`) ? name.slice(0, -zone.length - 1) : name;
}
/** Pure: who serves a hostname, in a few words. */
export function sourcesLabel(sources: readonly HostnameSource[]): string {
  return sources
    .map((source) =>
      source.kind === "route"
        ? "your route (proxy.routes)"
        : `${source.project} / ${source.target}`,
    )
    .join(", ");
}
/** Pure: the command "Point at this Mac" sends: the A record the check planned, with what it expects to find. */
export function fixCommand(fix: PointFix): RuntimeCommand {
  return fix.op === "create"
    ? {
        action: "dns-create",
        dns: { zone: fix.zone, record: fix.record, absent: true },
      }
    : {
        action: "dns-update",
        dns: {
          zone: fix.zone,
          id: fix.id,
          modifiedOn: fix.modifiedOn,
          record: fix.record,
        },
      };
}
/** Pure: what "Point at this Mac" will do, said before it is pressed. */
export function fixDescription(fix: PointFix): string {
  if (fix.op === "update")
    return `Changes its A record from ${fix.from} to ${fix.record.content}, DNS only.`;
  return `Adds an A record ${fix.record.name} -> ${fix.record.content}, DNS only${
    fix.overrides ? `, which answers for it instead of ${fix.overrides}` : ""
  }.`;
}
/** What the record dialog holds while it is edited: every field as typed. */
export interface RecordDraft {
  type: DnsRecordType;
  /** Relative to the zone; `@` is the zone itself. */
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority: string;
  comment: string;
}
/** Pure: a new record's starting fields, or an existing record's. */
export function recordDraft(zone: string, record?: DnsRecord): RecordDraft {
  if (!record)
    return {
      type: "A",
      name: "",
      content: "",
      ttl: AUTOMATIC_TTL,
      proxied: false,
      priority: "10",
      comment: "",
    };
  return {
    type: record.type as DnsRecordType,
    name: relativeName(record.name, zone),
    content: record.content,
    ttl: record.ttl,
    proxied: record.proxied === true,
    priority: record.priority === undefined ? "10" : String(record.priority),
    comment: record.comment ?? "",
  };
}
/** Pure: the draft as the record rigd is asked to write, or each field's problem by its name. */
export function draftRecord(
  zone: string,
  draft: RecordDraft,
):
  | { ok: true; record: DnsRecordInput }
  | { ok: false; issues: Partial<Record<keyof RecordDraft, string>> } {
  if (!draft.name.trim())
    return {
      ok: false,
      issues: { name: "Name the record, or type @ for the zone itself." },
    };
  const proxiable = PROXIABLE_TYPES.includes(draft.type);
  const priority = draft.priority.trim();
  if (draft.type === "MX" && !/^\d{1,5}$/.test(priority))
    return {
      ok: false,
      issues: {
        priority: "It must be a whole number from 0 to 65535, such as 10.",
      },
    };
  const parsed = dnsRecordInputSchema.safeParse({
    name: qualifyName(draft.name, zone),
    type: draft.type,
    content: draft.content.trim(),
    ttl: draft.ttl,
    ...(proxiable ? { proxied: draft.proxied } : {}),
    ...(draft.type === "MX" ? { priority: Number(priority) } : {}),
    ...(draft.comment.trim() ? { comment: draft.comment.trim() } : {}),
  });
  if (parsed.success)
    return { ok: true, record: normalizeRecordInput(parsed.data) };
  const issues: Partial<Record<keyof RecordDraft, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? "content") as keyof RecordDraft;
    issues[field] ??=
      `${field === "name" ? "The name" : "It"} ${issue.message}.`;
  }
  return { ok: false, issues };
}
/** Pure: the command that saves a draft: a create, or an update of the record it was opened on with what was read. */
export function saveCommand(
  zone: string,
  record: DnsRecordInput,
  original?: DnsRecord,
  /** The zone's records as the page read them. A create of a name and type it showed no record of says so (`absent`),
   * so rigd refuses it if one appeared since; one beside records it showed adds another, as asked. */
  shown: readonly DnsRecord[] = [],
): RuntimeCommand {
  if (original)
    return {
      action: "dns-update",
      dns: { zone, id: original.id, modifiedOn: original.modifiedOn, record },
    };
  const free = !shown.some(
    (each) => each.name === record.name && each.type === record.type,
  );
  return {
    action: "dns-create",
    dns: { zone, record, ...(free ? { absent: true } : {}) },
  };
}
/** Pure: the command that deletes a record as it was read, with the name the person typed to confirm it. */
export function deleteCommand(
  record: DnsRecord,
  typed: string,
): RuntimeCommand {
  return {
    action: "dns-delete",
    dns: {
      zone: record.zone,
      id: record.id,
      modifiedOn: record.modifiedOn,
      confirm: typed.trim(),
    },
  };
}
/** Pure: whether what was typed confirms deleting `record`: its full name, any case. */
export function deleteConfirmed(
  typed: string,
  record: Pick<DnsRecord, "name">,
): boolean {
  return typed.trim().toLowerCase().replace(/\.$/, "") === record.name;
}
/** Pure: records whose name, type or content holds `query`, any case; every record without one. */
export function filterRecords(
  records: readonly DnsRecord[],
  query: string,
): DnsRecord[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [...records];
  return records.filter((record) =>
    [record.name, record.type, record.content, record.comment ?? ""].some(
      (field) => field.toLowerCase().includes(wanted),
    ),
  );
}
/** Pure: what the DNS section says when rigd cannot read the records: what is missing and the steps that set it up. */
export function dnsSetup(failure: Failure): { title: string; steps: string[] } {
  const token =
    "Create a Cloudflare API token with Zone:Zone:Read and Zone:DNS:Edit on your zone, copy it, and run pbpaste | rig proxy token on this Mac.";
  switch (failure.code) {
    case "DNS_UNCONFIGURED":
    case "PROXY_UNMANAGED":
      return {
        title: "DNS needs Rig's own Caddy",
        steps: [
          "Add a proxy section to config.yaml under the Rig root, with tls.dns: cloudflare (the default).",
          token,
          "Run rigd install.",
        ],
      };
    case "DNS_TOKEN":
      return { title: "No usable DNS token", steps: [failure.message, token] };
    case "DNS_AUTH":
      return {
        title: "Cloudflare refused the DNS token",
        steps: [failure.message, token],
      };
    default:
      return {
        title: "DNS records could not be read",
        steps: [failure.message, ...(failure.hint ? [failure.hint] : [])],
      };
  }
}

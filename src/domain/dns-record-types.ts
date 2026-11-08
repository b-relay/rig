// The record types and TTL the DNS commands' grammar offers, apart from the record rules in dns-records.ts, so their help
// and the dashboard's browser code load no schema.

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

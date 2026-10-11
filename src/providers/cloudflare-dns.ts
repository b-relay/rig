import { z } from "zod";
import { RigError } from "../domain/errors";
import { redactSecrets } from "../domain/managed-proxy";
import {
  PROXIABLE_TYPES,
  caaParts,
  canonicalName,
  type DnsRecord,
  type DnsRecordInput,
  type DnsZone,
} from "../domain/dns-records";
import type { DnsProvider } from "./contracts";

/** Cloudflare's API v4. */
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
/** How long one request may take, body included. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** How many pages one listing reads at most: 100 pages of 100 records. */
const DEFAULT_MAX_PAGES = 100;
const ZONES_PER_PAGE = 50;
const RECORDS_PER_PAGE = 100;
/** Cloudflare ids are 32 hex digits; anything that is not a short run of letters and digits never reaches a URL path. */
const ID = /^[A-Za-z0-9]{1,64}$/;

export interface CloudflareDnsOptions {
  /** The API token. It is sent only in the Authorization header and never appears in a failure. */
  readonly token: string;
  /** The HTTP client; tests pass one that answers like Cloudflare. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** The API's base URL; tests point it at a fake server on 127.0.0.1. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxPages?: number;
}

const envelopeSchema = z.object({
  success: z.boolean(),
  errors: z
    .array(
      z.object({ code: z.number().optional(), message: z.string().optional() }),
    )
    .optional(),
  result: z.unknown(),
  result_info: z
    .object({
      page: z.number().int().optional(),
      total_pages: z.number().int().optional(),
    })
    .optional(),
});
type Envelope = z.infer<typeof envelopeSchema>;
const zoneSchema = z.object({
  id: z.string().regex(ID),
  name: z.string().min(1).max(253),
  status: z.string().optional(),
});
const recordSchema = z.object({
  id: z.string().regex(ID),
  name: z.string().min(1).max(253),
  type: z.string().min(1).max(16),
  content: z.string(),
  ttl: z.number().int(),
  proxied: z.boolean().optional(),
  priority: z.number().int().optional(),
  comment: z.string().nullable().optional(),
  modified_on: z.string().min(1),
});

/** Cloudflare's DNS records API behind Rig's DnsProvider contract (ADR 0018). Every request has a deadline and is never
 * redirected (so the token goes nowhere else), every answer is checked against a schema, and every failure is a RigError
 * whose text has the token removed even if Cloudflare quoted it. */
export function createCloudflareDns(
  options: CloudflareDnsOptions,
): DnsProvider {
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  const base = (options.baseUrl ?? CLOUDFLARE_API).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const clean = (text: string) =>
    redactSecrets(text, [options.token])
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, 300);
  const said = (envelope: Envelope | undefined) =>
    clean(
      (envelope?.errors ?? [])
        .map((error) =>
          [error.message, error.code !== undefined ? `(${error.code})` : ""]
            .filter(Boolean)
            .join(" "),
        )
        .filter(Boolean)
        .join("; "),
    );
  const malformed = (what: string) =>
    new RigError(
      "DNS_PROVIDER_RESPONSE",
      `Cloudflare answered ${what} in a form Rig does not understand.`,
      "Retry; if it persists, Cloudflare's API may have changed, so report it with rig doctor's output.",
    );
  async function request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    what: string,
    body?: unknown,
    missingIsUndefined = false,
  ): Promise<Envelope | undefined> {
    let response: Response;
    try {
      response = await send(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
        // Never followed: the token would go with it. A redirect is reported as what it is, below.
        redirect: "manual",
      });
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "TimeoutError")
        throw new RigError(
          "DNS_TIMEOUT",
          `Cloudflare did not answer ${what} within ${timeoutMs / 1000} s.`,
          "Check this Mac's internet connection and retry.",
        );
      throw new RigError(
        "DNS_UNREACHABLE",
        `Cloudflare's API could not be reached for ${what}.`,
        "Check this Mac's internet connection and DNS, then retry.",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new RigError(
        "DNS_PROVIDER_RESPONSE",
        `Cloudflare answered ${what} with a redirect (HTTP ${response.status}), which Rig does not follow.`,
        "Retry; if it persists, something between this Mac and api.cloudflare.com is rewriting requests.",
        { status: response.status },
      );
    }
    // The body is read whole first: one cut off in transit is a lost answer (the write may have been made), and only a
    // complete body that is not JSON is an answer Rig does not understand.
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "TimeoutError")
        throw new RigError(
          "DNS_TIMEOUT",
          `Cloudflare did not finish answering ${what} within ${timeoutMs / 1000} s.`,
          "Check this Mac's internet connection and retry.",
        );
      throw new RigError(
        "DNS_UNREACHABLE",
        `Cloudflare's answer to ${what} was cut off.`,
        "Check this Mac's internet connection, read the records again, then retry.",
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
    const parsed = envelopeSchema.safeParse(payload);
    const envelope = parsed.success ? parsed.data : undefined;
    const reason = said(envelope);
    const because = reason ? `: ${reason}` : ".";
    if (response.status === 401 || response.status === 403)
      throw new RigError(
        "DNS_AUTH",
        `Cloudflare refused the API token for ${what}${because}`,
        "The token in auth/acme-dns.token needs Zone:Zone:Read and Zone:DNS:Edit on the zone. Create one in the Cloudflare dashboard and store it with: pbpaste | rig proxy token",
        { status: response.status },
      );
    if (response.status === 429)
      throw new RigError(
        "DNS_RATE_LIMIT",
        `Cloudflare is rate limiting this token (${what}).`,
        "Wait a few minutes and retry.",
        { status: 429 },
      );
    if (missingIsUndefined && response.status === 404) return undefined;
    if (!response.ok || !envelope?.success) {
      if (!envelope && response.ok) throw malformed(what);
      throw new RigError(
        "DNS_PROVIDER",
        `Cloudflare refused ${what}${because}`,
        response.status >= 500
          ? "Cloudflare had a problem; retry in a minute."
          : "Check the record's name, type and content; Cloudflare's reason is above.",
        { status: response.status },
      );
    }
    return envelope;
  }
  async function list<T>(
    path: string,
    perPage: number,
    schema: z.ZodType<T>,
    what: string,
  ): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      if (page > maxPages)
        throw new RigError(
          "DNS_PROVIDER",
          `Cloudflare listed more than ${maxPages} pages of ${what}.`,
          "Narrow the zones Rig manages with proxy.dns.zones in config.yaml.",
        );
      const envelope = (await request(
        "GET",
        `${path}?page=${page}&per_page=${perPage}`,
        what,
      ))!;
      const items = z.array(schema).safeParse(envelope.result);
      if (!items.success) throw malformed(what);
      all.push(...items.data);
      const total = envelope.result_info?.total_pages;
      if (total !== undefined ? page >= total : items.data.length < perPage)
        return all;
    }
  }
  const zonePath = (zone: DnsZone) => {
    if (!ID.test(zone.id)) throw malformed("a zone id");
    return `/zones/${zone.id}/dns_records`;
  };
  const recordPath = (zone: DnsZone, id: string) => {
    if (!ID.test(id))
      throw new RigError(
        "DNS_REQUEST",
        "That is not a DNS record id.",
        "Read the records again and pick one from the list.",
      );
    return `${zonePath(zone)}/${id}`;
  };
  const toRecord = (
    zone: DnsZone,
    raw: z.infer<typeof recordSchema>,
  ): DnsRecord => ({
    id: raw.id,
    zone: zone.name,
    name: canonicalName(raw.name),
    type: raw.type,
    content:
      raw.type === "CNAME" || raw.type === "MX"
        ? canonicalName(raw.content)
        : raw.content,
    ttl: raw.ttl,
    ...(raw.proxied !== undefined ? { proxied: raw.proxied } : {}),
    ...(raw.priority !== undefined && raw.type === "MX"
      ? { priority: raw.priority }
      : {}),
    ...(raw.comment ? { comment: raw.comment } : {}),
    modifiedOn: raw.modified_on,
  });
  const single = (
    zone: DnsZone,
    envelope: Envelope | undefined,
    what: string,
  ) => {
    const parsed = recordSchema.safeParse(envelope?.result);
    if (!parsed.success) throw malformed(what);
    return toRecord(zone, parsed.data);
  };
  /** The JSON body Cloudflare takes for a record: CAA as structured data, `proxied` only where it applies. An update
   * without a comment leaves the stored one as it is. */
  const body = (record: DnsRecordInput) => {
    const caa = record.type === "CAA" ? caaParts(record.content) : undefined;
    return {
      name: record.name,
      type: record.type,
      ttl: record.ttl,
      ...(caa ? { data: caa } : { content: record.content }),
      ...(PROXIABLE_TYPES.includes(record.type)
        ? { proxied: record.proxied === true }
        : {}),
      ...(record.type === "MX" ? { priority: record.priority } : {}),
      ...(record.comment !== undefined ? { comment: record.comment } : {}),
    };
  };
  return {
    async zones() {
      const zones = await list(
        "/zones",
        ZONES_PER_PAGE,
        zoneSchema,
        "the zone list",
      );
      return zones.map((zone) => ({
        id: zone.id,
        name: canonicalName(zone.name),
        status: zone.status ?? "unknown",
      }));
    },
    async records(zone) {
      const records = await list(
        zonePath(zone),
        RECORDS_PER_PAGE,
        recordSchema,
        `the records of ${zone.name}`,
      );
      return records.map((record) => toRecord(zone, record));
    },
    async record(zone, id) {
      const what = `a record of ${zone.name}`;
      const envelope = await request(
        "GET",
        recordPath(zone, id),
        what,
        undefined,
        true,
      );
      return envelope ? single(zone, envelope, what) : undefined;
    },
    async create(zone, record) {
      const what = `the new ${record.type} record ${record.name}`;
      return single(
        zone,
        await request("POST", zonePath(zone), what, body(record)),
        what,
      );
    },
    async update(zone, id, record) {
      const what = `the change to ${record.type} ${record.name}`;
      const envelope = await request(
        "PATCH",
        recordPath(zone, id),
        what,
        body(record),
        true,
      );
      return envelope ? single(zone, envelope, what) : undefined;
    },
    async delete(zone, id) {
      const envelope = await request(
        "DELETE",
        recordPath(zone, id),
        `deleting a record of ${zone.name}`,
        undefined,
        true,
      );
      return envelope !== undefined;
    },
  };
}

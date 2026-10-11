import type { ProxySettings } from "../config/proxy-schema";
import { RigError, asRigError } from "../domain/errors";
import {
  DNS_RECORD_TYPES,
  createConflicts,
  describeRecord,
  dnsRecordInputSchema,
  canonicalName,
  inZone,
  normalizeRecordInput,
  sameContent,
  type DnsRecord,
  type DnsRecordInput,
  type DnsZone,
} from "../domain/dns-records";
import { checkHostnames, type ServedHostname } from "../domain/dns-hostnames";
import type { DnsProvider, HostAddress } from "../providers/contracts";
import type { DnsRequest } from "../daemon/protocol";
import type {
  DnsControl,
  DnsReport,
  DnsWriteAction,
  PreparedDnsWrite,
} from "../runtime/contracts";

/** How many zones' records are read at once. */
const ZONE_READS_AT_ONCE = 4;
export interface DnsControlOptions {
  /** Host config's proxy section as it is now; undefined without one. */
  settings(): Promise<ProxySettings | undefined>;
  /** The DNS provider token; fails DNS_TOKEN when there is none to use. */
  token(): Promise<string>;
  /** The provider `proxy.tls.dns` names (`name`), holding `token`. */
  provider(name: string, token: string): DnsProvider;
  /** This Mac's address when Host config does not set one. */
  address: HostAddress;
}

const unconfigured = () =>
  new RigError(
    "DNS_UNCONFIGURED",
    "DNS records are managed with Rig's own Caddy, and Host config has no proxy section.",
    "Add a proxy section to config.yaml under the Rig root (rig-guide: Rig's own Caddy), store the Cloudflare token with pbpaste | rig proxy token, and run rigd install.",
  );
const changed = (what: string) =>
  new RigError(
    "DNS_CHANGED",
    `${what} since you read it, so Rig did not write.`,
    "Read the records again (reload the page, or rig dns list), check the change, and retry.",
  );
/** Whether a write's answer was lost, so Cloudflare may or may not have made it. */
const lost = (error: unknown) =>
  error instanceof RigError &&
  (error.code === "DNS_TIMEOUT" || error.code === "DNS_UNREACHABLE");
/** The failure for a lost answer that reading again could not settle. */
const uncertain = (error: RigError, what: string) =>
  new RigError(
    "DNS_UNCERTAIN",
    `${error.message} Rig could not tell whether ${what} was made.`,
    "Read the records again (reload the page, or rig dns list) before retrying.",
  );
/** Pure: `items` mapped by `each`, at most `limit` at a time, each settled on its own. */
async function settledInBatches<T, R>(
  items: readonly T[],
  limit: number,
  each: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let start = 0; start < items.length; start += limit)
    results.push(
      ...(await Promise.allSettled(
        items.slice(start, start + limit).map(each),
      )),
    );
  return results;
}

/** DNS record management behind rigd's `dns` commands (ADR 0018): reads Host config and the token at every request, so
 * a change to either needs no restart, and the provider is created for that request alone. */
export function createDnsControl(options: DnsControlOptions): DnsControl {
  const configured = async () => {
    const settings = await options.settings();
    if (!settings) throw unconfigured();
    return settings;
  };
  const connect = async (settings: ProxySettings) => {
    const provider = options.provider(settings.tls.dns, await options.token());
    const visible = await provider.zones();
    const allowed = settings.dns?.zones;
    const zones = allowed
      ? visible.filter((zone) => allowed.includes(zone.name))
      : visible;
    const unseen = allowed?.filter(
      (name) => !visible.some((zone) => zone.name === name),
    );
    return { provider, zones, ...(unseen?.length ? { unseen } : {}) };
  };
  const zoneNamed = (zones: readonly DnsZone[], name: string | undefined) => {
    const zone = zones.find((each) => each.name === name);
    if (!zone)
      throw new RigError(
        "DNS_ZONE",
        name
          ? `Rig does not manage the zone ${name}.`
          : "A DNS change must name its zone.",
        "rig dns list shows the zones the token can see; proxy.dns.zones in config.yaml narrows them.",
        name ? { zone: name } : {},
      );
    return zone;
  };
  const validRecord = (request: DnsRequest, zone: DnsZone): DnsRecordInput => {
    const parsed = dnsRecordInputSchema.safeParse(request.record);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.map(String).join(".") || "record";
      throw new RigError(
        "DNS_RECORD",
        `The record's ${field} ${issue?.message ?? "is invalid"}.`,
        "Fix that field and retry.",
        { field },
      );
    }
    const record = normalizeRecordInput(parsed.data);
    if (!inZone(record.name, zone.name))
      throw new RigError(
        "DNS_RECORD",
        `${record.name} is not in the zone ${zone.name}.`,
        `Name a record ending in .${zone.name}, or ${zone.name} itself.`,
        { field: "name" },
      );
    return record;
  };
  /** The record as it is now, refused unless it still is what the caller read. */
  const unchanged = async (
    provider: DnsProvider,
    zone: DnsZone,
    request: DnsRequest,
  ): Promise<DnsRecord> => {
    if (!request.id || !request.modifiedOn)
      throw new RigError(
        "DNS_REQUEST",
        "An update or delete must name the record and when it was last changed, as the read listed them.",
        "Read the records again and pick one from the list.",
      );
    const current = await provider.record(zone, request.id);
    if (!current) throw changed("The record was deleted");
    if (current.modifiedOn !== request.modifiedOn)
      throw changed(`${current.type} ${current.name} changed`);
    if (!(DNS_RECORD_TYPES as readonly string[]).includes(current.type))
      throw new RigError(
        "DNS_RECORD",
        `Rig does not change ${current.type} records.`,
        "Change it in the Cloudflare dashboard.",
      );
    return current;
  };
  /** Whether `record` says what `wanted` asks for, as far as a lost write can be judged. */
  /** Whether `record` says everything `wanted` asked for, as a lost write is judged: every field the request carries
   * (a comment only when it carried one, since an absent comment leaves the stored one). */
  const says = (record: DnsRecord, wanted: DnsRecordInput) =>
    record.name === wanted.name &&
    record.type === wanted.type &&
    sameContent(record.type, record.content, wanted.content) &&
    record.ttl === wanted.ttl &&
    (record.proxied ?? false) === (wanted.proxied ?? false) &&
    record.priority === wanted.priority &&
    (wanted.comment === undefined || record.comment === wanted.comment);
  async function hostAddress(settings: ProxySettings) {
    if (settings.dns?.address)
      return {
        address: settings.dns.address,
        addressSource: "config" as const,
      };
    const address = await options.address.ipv4().catch(() => undefined);
    return address ? { address, addressSource: "tailscale" as const } : {};
  }
  return {
    async read(input): Promise<DnsReport> {
      const settings = await configured();
      const [{ provider, zones: managed, unseen }, mac] = await Promise.all([
        connect(settings),
        hostAddress(settings),
      ]);
      if (input.zone !== undefined) zoneNamed(managed, input.zone);
      // Each zone is read on its own, so one zone the token cannot read (or a rate limit) leaves the others shown.
      const reads = await settledInBatches(
        managed,
        ZONE_READS_AT_ONCE,
        (zone) => provider.records(zone),
      );
      const zones = managed.filter(
        (_, index) => reads[index]!.status === "fulfilled",
      );
      const failures = managed.flatMap((zone, index) => {
        const read = reads[index]!;
        return read.status === "rejected"
          ? [{ zone, error: asRigError(read.reason) }]
          : [];
      });
      // With no zone readable there is nothing to show: the first failure says why (a token without DNS read, say).
      if (managed.length && !zones.length) throw failures[0]!.error;
      const records = reads
        .flatMap((read) => (read.status === "fulfilled" ? read.value : []))
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name) ||
            a.type.localeCompare(b.type) ||
            a.content.localeCompare(b.content),
        );
      const served = new Map<string, ServedHostname>();
      for (const entry of [
        ...input.hostnames,
        ...Object.keys(settings.routes).map((hostname) => ({
          hostname,
          sources: [{ kind: "route" as const }],
        })),
      ]) {
        const known = served.get(entry.hostname);
        served.set(entry.hostname, {
          hostname: entry.hostname,
          sources: [...(known?.sources ?? []), ...entry.sources],
        });
      }
      const hostnames = checkHostnames({
        hostnames: [...served.values()],
        zones,
        records,
        address: mac.address,
        unreadable: failures.map((failure) => failure.zone),
      });
      const shown = (name: string) =>
        input.zone === undefined || inZone(name, input.zone);
      return {
        provider: settings.tls.dns,
        ...mac,
        zones: zones.filter((zone) => shown(zone.name)),
        ...(unseen ? { unseenZones: unseen } : {}),
        ...(failures.length
          ? {
              unreadableZones: failures
                .filter((failure) => shown(failure.zone.name))
                .map(({ zone, error }) => ({
                  zone: zone.name,
                  code: error.code,
                  message: error.message,
                })),
            }
          : {}),
        records: records.filter(
          (record) => input.zone === undefined || record.zone === input.zone,
        ),
        hostnames: hostnames.filter((check) => shown(check.hostname)),
      };
    },
    async prepare(action: DnsWriteAction, request): Promise<PreparedDnsWrite> {
      const settings = await configured();
      const { provider, zones } = await connect(settings);
      const zone = zoneNamed(zones, request.zone);
      if (action === "dns-create") {
        const record = validRecord(request, zone);
        if (request.absent) {
          const conflicts = createConflicts(
            await provider.records(zone),
            record,
          );
          if (conflicts.length)
            throw changed(
              `${record.name} gained ${conflicts.map((each) => `${each.type} ${each.content}`).join(", ")}`,
            );
        }
        return {
          zone: zone.name,
          change: `create ${describeRecord(record)}`,
          summary: `created ${describeRecord(record)}`,
          async apply() {
            try {
              return await provider.create(zone, record);
            } catch (error) {
              if (!lost(error)) throw error;
              // Cloudflare may have made it before the answer was lost; an identical record is never created twice.
              const now = await provider.records(zone).catch(() => undefined);
              const made = now?.find((each) => says(each, record));
              if (made) return made;
              if (now) throw error;
              throw uncertain(error as RigError, "the record");
            }
          },
        };
      }
      const current = await unchanged(provider, zone, request);
      if (action === "dns-delete") {
        // The typed confirmation is checked here, against the record as it is now, so no client can skip it.
        if (
          request.confirm === undefined ||
          canonicalName(request.confirm) !== current.name
        )
          throw new RigError(
            "DNS_CONFIRMATION",
            request.confirm === undefined
              ? `Deleting ${current.type} ${current.name} needs its name typed to confirm.`
              : `What was typed does not name ${current.type} ${current.name}, so Rig did not delete it.`,
            "Type the record's full name to confirm the delete (rig dns delete sends it after asking, or with --yes).",
          );
        return {
          zone: zone.name,
          change: `delete ${describeRecord(current)}`,
          summary: `deleted ${describeRecord(current)}`,
          async apply() {
            let existed: boolean;
            try {
              existed = await provider.delete(zone, current.id);
            } catch (error) {
              if (!lost(error)) throw error;
              const now = await provider.record(zone, current.id).then(
                (record) => ({ record }),
                () => undefined,
              );
              if (now && !now.record) return undefined;
              if (now) throw error;
              throw uncertain(error as RigError, "the delete");
            }
            if (!existed) throw changed("The record was deleted");
            return undefined;
          },
        };
      }
      const record = validRecord(request, zone);
      if (record.type !== current.type)
        throw new RigError(
          "DNS_RECORD",
          `A ${current.type} record cannot become ${record.type}.`,
          "Delete it and add a new record instead.",
          { field: "type" },
        );
      const was = [
        current.name !== record.name ? `renamed from ${current.name}` : "",
        current.content !== record.content ? `was ${current.content}` : "",
      ].filter(Boolean);
      const note = was.length ? ` (${was.join(", ")})` : "";
      return {
        zone: zone.name,
        change: `update ${describeRecord(record)}${note}`,
        summary: `updated ${describeRecord(record)}${note}`,
        async apply() {
          let written: DnsRecord | undefined;
          try {
            written = await provider.update(zone, current.id, record);
          } catch (error) {
            if (!lost(error)) throw error;
            const now = await provider.record(zone, current.id).then(
              (found) => ({ found }),
              () => undefined,
            );
            if (now?.found && says(now.found, record)) return now.found;
            if (now) throw error;
            throw uncertain(error as RigError, "the change");
          }
          if (!written) throw changed("The record was deleted");
          return written;
        },
      };
    },
  };
}

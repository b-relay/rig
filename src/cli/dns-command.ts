import { Command, InvalidArgumentError } from "commander";
import { z } from "zod";
import { RigError, cancelled } from "../domain/errors";
import {
  AUTOMATIC_TTL,
  DNS_RECORD_TYPES,
  PROXIABLE_TYPES,
  canonicalName,
  createConflicts,
  describeRecord,
  dnsRecordInputSchema,
  normalizeRecordInput,
  qualifyName,
  recordsAt,
  sameContent,
  zoneOf,
  type DnsRecord,
  type DnsRecordInput,
  type DnsRecordType,
} from "../domain/dns-records";
import type { DnsRequest, RuntimeCommand } from "../daemon/protocol";
import type { CliInteraction } from "./interaction";
import type { UserOutput } from "./types";
import { terminalText } from "./terminal-text";

export interface DnsCommandDependencies {
  cwd: string;
  /** Sends the final command and renders its reply, as every rig command does. */
  execute(request: RuntimeCommand, options?: { json?: boolean }): Promise<void>;
  /** Reads rigd's `dns` report, to plan a change against the records as they are. */
  read(request: RuntimeCommand): Promise<unknown>;
  /** Asks the person at the terminal; absent without one. */
  interaction?: CliInteraction;
  output: UserOutput;
}
/** The part of the `dns` reply a change is planned from; anything else in it is ignored. */
const reportSchema = z.object({
  zones: z.array(z.object({ id: z.string(), name: z.string() })),
  records: z.array(
    z.object({
      id: z.string(),
      zone: z.string(),
      name: z.string(),
      type: z.string(),
      content: z.string(),
      ttl: z.number(),
      proxied: z.boolean().optional(),
      priority: z.number().optional(),
      comment: z.string().optional(),
      modifiedOn: z.string(),
    }),
  ),
});
type Report = z.infer<typeof reportSchema>;
interface ChangeOptions {
  zone?: string;
  yes?: boolean;
}
interface SetOptions extends ChangeOptions {
  ttl?: number;
  proxied?: boolean;
  priority?: number;
  comment?: string;
  add?: boolean;
  replace?: boolean;
}
interface DeleteOptions extends ChangeOptions {
  content?: string;
}

/** `rig dns`: the DNS records of the zones the proxy's token can see, and changes to them through rigd (ADR 0018). A change
 * is planned against the records as rigd reads them now, shown, and confirmed before it is sent with what it expects to
 * find, so rigd refuses it if the record changed meanwhile. */
export function addDnsCommands(
  command: Command,
  dependencies: DnsCommandDependencies,
): void {
  const { cwd, execute } = dependencies;
  const dns = command
    .command("dns")
    .description(
      "Manage the DNS records of your zones with the token rig proxy token stored, and check where each hostname Rig serves points.",
    );
  dns
    .command("list")
    .description(
      "List the records of every zone Rig manages, or of one, and where each hostname Rig serves points.",
    )
    .argument("[zone]", "Only this zone, such as example.com")
    .option("--json", "Render the report as JSON")
    .action(async (zone: string | undefined, options: { json?: boolean }) =>
      execute(
        {
          action: "dns",
          repoPath: cwd,
          ...(zone ? { dns: { zone: canonicalName(zone) } } : {}),
        },
        { json: options.json },
      ),
    );
  dns
    .command("set")
    .description(
      "Create a record, or change the one A, AAAA or CNAME record of that name (TXT, MX and CAA add one unless --replace). A one-label name is relative to the zone, @ is the zone itself, and --zone makes any name relative. Asks before it writes unless --yes.",
    )
    .argument("<name>", "Record name, such as app, app.example.com or @")
    .argument(
      "<type>",
      `Record type: ${DNS_RECORD_TYPES.join(", ")}`,
      recordType,
    )
    .argument("<content>", "An address, a hostname, text, or CAA data")
    .option(
      "--ttl <seconds>",
      "Seconds resolvers may cache it, 60 to 86400 (30 on Enterprise), or auto (default: the record's own, else auto)",
      ttl,
    )
    .option("--proxied", "A, AAAA, CNAME: answer through Cloudflare's proxy")
    .option(
      "--no-proxied",
      "A, AAAA, CNAME: answer with the content (DNS only)",
    )
    .option(
      "--priority <number>",
      "MX preference (default: the record's own, else 10)",
      count,
    )
    .option("--comment <text>", "A note kept with the record")
    .option(
      "--add",
      "Add another record of this name and type instead of changing one (the default for TXT, MX and CAA)",
    )
    .option(
      "--replace",
      "TXT, MX, CAA: change the one record of this name and type instead of adding one",
    )
    .option("--zone <zone>", "The zone, when the name alone does not say")
    .option("-y, --yes", "Write without asking")
    .action(
      async (
        name: string,
        type: DnsRecordType,
        content: string,
        options: SetOptions,
      ) => {
        const report = await readReport(dependencies);
        const zone = chooseZone(report, name, options.zone);
        const fqdn = qualifyName(name, zone);
        const plan = planSet(
          report.records.filter(
            (record) => record.name === fqdn,
          ) as DnsRecord[],
          { zone, name: fqdn, type, content },
          options,
        );
        if (plan.op === "unchanged") {
          dependencies.output.write(
            `${terminalText(describeRecord(plan.record))} is already set.\n`,
          );
          return;
        }
        await confirm(
          dependencies,
          options,
          plan.op === "create"
            ? `Create ${describe(plan.record)}?`
            : `Change ${describe(plan.current)} to ${describe(plan.record)}?`,
        );
        await execute({
          action: plan.op === "create" ? "dns-create" : "dns-update",
          repoPath: cwd,
          dns: plan.request,
        });
      },
    );
  dns
    .command("delete")
    .description(
      "Delete the record of that name and type; --content picks one when there are several. Asks before it writes unless --yes.",
    )
    .argument("<name>", "Record name, such as app, app.example.com or @")
    .argument(
      "<type>",
      `Record type: ${DNS_RECORD_TYPES.join(", ")}`,
      recordType,
    )
    .option("--content <content>", "Only the record with this content")
    .option("--zone <zone>", "The zone, when the name alone does not say")
    .option("-y, --yes", "Delete without asking")
    .action(
      async (name: string, type: DnsRecordType, options: DeleteOptions) => {
        const report = await readReport(dependencies);
        const zone = chooseZone(report, name, options.zone);
        const fqdn = qualifyName(name, zone);
        const matches = recordsAt(report.records, fqdn, type).filter(
          (record) =>
            options.content === undefined ||
            sameContent(record.type, record.content, options.content),
        );
        if (!matches.length)
          throw new RigError(
            "DNS_NOT_FOUND",
            `${fqdn} has no ${type} record${options.content !== undefined ? " with that content" : ""}.`,
            `rig dns list ${zone} shows the zone's records.`,
          );
        if (matches.length > 1)
          throw new RigError(
            "DNS_AMBIGUOUS",
            `${fqdn} has ${matches.length} ${type} records: ${matches.map((each) => JSON.stringify(each.content)).join(", ")}.`,
            `Pick one with --content, for example: rig dns delete ${fqdn} ${type} --content ${JSON.stringify(matches[0]!.content)}`,
          );
        const record = matches[0]!;
        await confirm(dependencies, options, `Delete ${describe(record)}?`);
        await execute({
          action: "dns-delete",
          repoPath: cwd,
          // Asked above, or waived with --yes: the record's own name is the confirmation rigd checks.
          dns: {
            zone,
            id: record.id,
            modifiedOn: record.modifiedOn,
            confirm: record.name,
          },
        });
      },
    );
}
/** A planned `rig dns set`: what it sends, and what it found. */
export type SetPlan =
  | { op: "create"; record: DnsRecordInput; request: DnsRequest }
  | {
      op: "update";
      record: DnsRecordInput;
      current: DnsRecord;
      request: DnsRequest;
    }
  | { op: "unchanged"; record: DnsRecord };
/** Types a name commonly holds several of (SPF beside verifications, a backup MX, several CAs), so `rig dns set` adds one
 * unless `--replace` asks it to change the one there. */
export const MULTI_VALUED_TYPES: readonly DnsRecordType[] = [
  "TXT",
  "MX",
  "CAA",
];
/** Pure: what `rig dns set` does with the records at the name now (`atName`, every type).
 * - A record of that type with the same content is changed in place (its TTL, proxying, priority, comment), or left.
 * - A, AAAA, CNAME: the one record of that type is replaced; several are ambiguous unless `add` asks for another.
 * - TXT, MX, CAA: a new record is added beside any there, unless `replace` asks to change the one there.
 * - A new record is refused where a CNAME is, and a new CNAME where any record is: DNS allows nothing beside a CNAME.
 * Unset options keep the record's own. */
export function planSet(
  atName: readonly DnsRecord[],
  wanted: { zone: string; name: string; type: DnsRecordType; content: string },
  options: Pick<
    SetOptions,
    "ttl" | "proxied" | "priority" | "comment" | "add" | "replace"
  >,
): SetPlan {
  if (options.add && options.replace)
    throw new RigError(
      "USAGE",
      "--add and --replace ask for opposite things.",
      "Pass one of them.",
    );
  const existing = atName.filter((record) => record.type === wanted.type);
  const same = existing.find((record) =>
    sameContent(record.type, record.content, wanted.content),
  );
  const adds =
    options.add ||
    (MULTI_VALUED_TYPES.includes(wanted.type) && !options.replace);
  const current =
    same ??
    (adds ? undefined : existing.length === 1 ? existing[0] : undefined);
  if (!current && !adds && existing.length > 1)
    throw new RigError(
      "DNS_AMBIGUOUS",
      `${wanted.name} has ${existing.length} ${wanted.type} records, so rig dns set cannot tell which to change.`,
      `Pass --add to add another, or delete the ones you do not want: rig dns delete ${wanted.name} ${wanted.type} --content <content>`,
    );
  if (!current) {
    const blocking = createConflicts(atName, wanted).filter(
      (record) => record.type === "CNAME" || wanted.type === "CNAME",
    );
    if (blocking.length)
      throw new RigError(
        "DNS_CONFLICT",
        wanted.type === "CNAME"
          ? `${wanted.name} already has ${blocking.map((each) => `${each.type} ${each.content}`).join(", ")}, and a CNAME cannot share its name with any record.`
          : `${wanted.name} is a CNAME to ${blocking[0]!.content}, and a CNAME cannot share its name with any record.`,
        `Delete what is there first, for example: rig dns delete ${wanted.name} ${blocking[0]!.type}`,
      );
  }
  const parsed = dnsRecordInputSchema.safeParse({
    name: wanted.name,
    type: wanted.type,
    content: wanted.content,
    ttl: options.ttl ?? current?.ttl ?? AUTOMATIC_TTL,
    ...(PROXIABLE_TYPES.includes(wanted.type)
      ? { proxied: options.proxied ?? current?.proxied ?? false }
      : options.proxied
        ? { proxied: true }
        : {}),
    ...(wanted.type === "MX"
      ? { priority: options.priority ?? current?.priority ?? 10 }
      : options.priority !== undefined
        ? { priority: options.priority }
        : {}),
    ...((options.comment ?? current?.comment)
      ? { comment: options.comment ?? current?.comment }
      : {}),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RigError(
      "DNS_RECORD",
      `The record's ${issue?.path.map(String).join(".") || "content"} ${issue?.message ?? "is invalid"}.`,
      "Fix it and run the command again; rig dns set --help lists the options.",
    );
  }
  const record = normalizeRecordInput(parsed.data);
  if (!current)
    return {
      op: "create",
      record,
      request: {
        zone: wanted.zone,
        record,
        // A name that had no record of this type when read must still have none when rigd writes.
        ...(existing.length === 0 ? { absent: true } : {}),
      },
    };
  if (
    sameContent(current.type, current.content, record.content) &&
    current.ttl === record.ttl &&
    (current.proxied ?? false) === (record.proxied ?? false) &&
    current.priority === record.priority &&
    (current.comment ?? undefined) === record.comment
  )
    return { op: "unchanged", record: current };
  return {
    op: "update",
    record,
    current,
    request: {
      zone: wanted.zone,
      id: current.id,
      modifiedOn: current.modifiedOn,
      record,
    },
  };
}
/** Pure: the zone a typed name belongs to: `--zone`, else the zone the name ends in, else the only zone for a name of one
 * label (`app`, `_dmarc`, `@`). A dotted name in no managed zone is refused rather than read as relative, since
 * `www.other.org` would otherwise become `www.other.org.example.com`; `--zone` makes it relative. */
export function chooseZone(
  report: Pick<Report, "zones">,
  name: string,
  option: string | undefined,
): string {
  const names = report.zones.map((zone) => zone.name);
  if (option !== undefined) {
    const zone = canonicalName(option);
    if (!names.includes(zone))
      throw new RigError(
        "DNS_ZONE",
        `Rig does not manage the zone ${zone}.`,
        names.length
          ? `It manages ${names.join(", ")}.`
          : "The token sees no zone; check its permissions in the Cloudflare dashboard.",
      );
    return zone;
  }
  const typed = canonicalName(name);
  const found = zoneOf(typed, report.zones)?.name;
  if (found) return found;
  if (names.length === 1 && !typed.includes(".")) return names[0]!;
  throw new RigError(
    "DNS_ZONE",
    names.length
      ? `${name} is in none of the zones Rig manages${typed.includes(".") ? "" : ", or it could be in several"}.`
      : "The DNS token sees no zone.",
    names.length
      ? `Name it in full, or pass --zone with one of ${names.join(", ")} to make it relative to that zone.`
      : "Give the token Zone:Zone:Read and Zone:DNS:Edit on your zone in the Cloudflare dashboard.",
  );
}
async function readReport(
  dependencies: DnsCommandDependencies,
): Promise<Report> {
  const parsed = reportSchema.safeParse(
    await dependencies.read({ action: "dns", repoPath: dependencies.cwd }),
  );
  if (!parsed.success)
    throw new RigError(
      "DAEMON_PROTOCOL",
      "rigd returned an invalid DNS report.",
      "Check that rig and rigd use the same version.",
    );
  return parsed.data;
}
/** Asks before a write unless --yes; without a terminal, --yes is required. */
async function confirm(
  dependencies: DnsCommandDependencies,
  options: ChangeOptions,
  question: string,
): Promise<void> {
  if (options.yes) return;
  if (!dependencies.interaction)
    throw new RigError(
      "DNS_CONFIRMATION",
      `${question.replace(/\?$/, "")} needs confirmation.`,
      "Run it from a terminal to be asked, or pass --yes.",
    );
  if (!(await dependencies.interaction.confirm(terminalText(question))))
    throw cancelled("No DNS record was changed.");
}
function describe(
  record: Pick<DnsRecord, "type" | "name" | "content" | "proxied" | "ttl">,
): string {
  const text =
    record.type === "TXT" || record.type === "CAA"
      ? `${record.type} ${record.name} ${JSON.stringify(record.content)}`
      : describeRecord(record);
  return `${text}, TTL ${record.ttl === AUTOMATIC_TTL ? "auto" : record.ttl}`;
}
function recordType(value: string): DnsRecordType {
  const type = value.toUpperCase();
  if (!(DNS_RECORD_TYPES as readonly string[]).includes(type))
    throw new InvalidArgumentError(
      `Use one of ${DNS_RECORD_TYPES.join(", ")}.`,
    );
  return type as DnsRecordType;
}
function ttl(value: string): number {
  if (value === "auto") return AUTOMATIC_TTL;
  if (!/^\d+$/.test(value))
    throw new InvalidArgumentError("Use seconds from 60 to 86400, or auto.");
  return Number(value);
}
function count(value: string): number {
  if (!/^\d+$/.test(value))
    throw new InvalidArgumentError("Use a whole number.");
  return Number(value);
}

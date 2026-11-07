import { Command, InvalidArgumentError } from "commander";
import {
  AUTOMATIC_TTL,
  DNS_RECORD_TYPES,
  type DnsRecordType,
} from "../domain/dns-record-types";
import type { RuntimeCommand } from "../daemon/protocol";
import type { CliInteraction } from "./interaction";
import type { UserOutput } from "./types";
import type { DeleteOptions, SetOptions } from "./dns-plan";

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

/** `rig dns`: the DNS records of the zones the proxy's token can see, and changes to them through rigd (ADR 0018). A change
 * is planned against the records as rigd reads them now, shown, and confirmed before it is sent with what it expects to
 * find, so rigd refuses it if the record changed meanwhile. This is the grammar alone: the planning (see dns-plan.ts)
 * and the record rules load once a dns command runs, since help needs neither. */
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
      "List the records of every zone Rig manages, or of one, and where each hostname they hold that Rig serves points. A zone that cannot be read fails a read of that zone; a read of every zone warns of it (unreadableZones with --json), lists the rest and exits 0.",
    )
    .argument(
      "[zone]",
      "Only this zone, such as example.com, and not a child zone of it",
    )
    .option("--json", "Render the report as JSON")
    .action(async (zone: string | undefined, options: { json?: boolean }) => {
      const { canonicalName } = await import("../domain/dns-records");
      await execute(
        {
          action: "dns",
          repoPath: cwd,
          ...(zone ? { dns: { zone: canonicalName(zone) } } : {}),
        },
        { json: options.json },
      );
    });
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
    .argument(
      "<content>",
      "An address, a hostname, text, or CAA data; for MX, . is a null MX, which says the name takes no mail",
    )
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
      "MX preference (default: 0 for a null MX, else the record's own, else 10)",
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
    .option(
      "--zone <zone>",
      "The zone, when the name alone does not say or should not: a name belongs to the longest zone that holds it",
    )
    .option("-y, --yes", "Write without asking")
    .action(
      async (
        name: string,
        type: DnsRecordType,
        content: string,
        options: SetOptions,
      ) =>
        (await import("./dns-plan")).setRecord(
          dependencies,
          name,
          type,
          content,
          options,
        ),
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
    .option(
      "--zone <zone>",
      "The zone, when the name alone does not say or should not: a name belongs to the longest zone that holds it",
    )
    .option("-y, --yes", "Delete without asking")
    .action(async (name: string, type: DnsRecordType, options: DeleteOptions) =>
      (await import("./dns-plan")).deleteRecord(
        dependencies,
        name,
        type,
        options,
      ),
    );
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

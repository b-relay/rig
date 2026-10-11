import { expect, test } from "bun:test";
import { commandSchema } from "../src/daemon/protocol";
import {
  deleteCommand,
  deleteConfirmed,
  dnsSetup,
  draftRecord,
  filterRecords,
  fixCommand,
  fixDescription,
  recordDraft,
  relativeName,
  saveCommand,
  ttlLabel,
} from "../web/lib/dns";
import type { DnsRecord } from "../web/lib/types";
import { DNS_DELETE_ELSEWHERE, confirmedDnsDelete } from "../web/server/dns";

const zone = "example.com";
const app: DnsRecord = {
  id: "a1",
  zone,
  name: "app.example.com",
  type: "A",
  content: "203.0.113.5",
  ttl: 300,
  proxied: true,
  comment: "web",
  modifiedOn: "2026-10-01T00:00:00Z",
};

test("names and TTLs read as Cloudflare's dashboard shows them", () => {
  expect(relativeName("example.com", zone)).toBe("@");
  expect(relativeName("api.app.example.com", zone)).toBe("api.app");
  expect(relativeName("other.org", zone)).toBe("other.org");
  expect([1, 60, 300, 3600, 86400, 90].map(ttlLabel)).toEqual([
    "Auto",
    "1 min",
    "5 min",
    "1 h",
    "1 d",
    "90 s",
  ]);
});

test("the record dialog's draft becomes the record rigd is asked to write, or each field's problem", () => {
  expect(recordDraft(zone, app)).toEqual({
    type: "A",
    name: "app",
    content: "203.0.113.5",
    ttl: 300,
    proxied: true,
    priority: "10",
    comment: "web",
  });
  const fresh = {
    ...recordDraft(zone),
    name: "@",
    type: "MX" as const,
    content: "Mail.Example.com.",
    priority: "5",
  };
  expect(draftRecord(zone, fresh)).toEqual({
    ok: true,
    record: {
      name: "example.com",
      type: "MX",
      content: "mail.example.com",
      ttl: 1,
      priority: 5,
    },
  });
  expect(
    draftRecord(zone, { ...recordDraft(zone), name: "app", content: "1.2.3" }),
  ).toEqual({
    ok: false,
    issues: { content: "It must be an IPv4 address such as 100.64.0.1." },
  });
  expect(draftRecord(zone, { ...recordDraft(zone), name: "" })).toMatchObject({
    ok: false,
    issues: { name: expect.any(String) },
  });
  expect(
    draftRecord(zone, {
      ...recordDraft(zone),
      type: "MX",
      name: "@",
      content: "mail.example.com",
      priority: "x",
    }),
  ).toMatchObject({
    ok: false,
    issues: { priority: expect.stringContaining("whole number") },
  });
});

test("every command the DNS section sends is one rigd's grammar accepts, and carries what the page read", () => {
  const record = {
    name: "app.example.com",
    type: "A" as const,
    content: "100.64.0.7",
    ttl: 1,
    proxied: false,
  };
  const commands = [
    saveCommand(zone, record),
    saveCommand(zone, record, app),
    deleteCommand(app, " app.example.com "),
    fixCommand({ op: "create", zone, record }),
    fixCommand({
      op: "update",
      zone,
      id: "a1",
      modifiedOn: app.modifiedOn,
      from: "203.0.113.5",
      record,
    }),
  ];
  for (const command of commands)
    expect(commandSchema.safeParse(command).success).toBe(true);
  expect(commands[1]).toEqual({
    action: "dns-update",
    dns: { zone, id: "a1", modifiedOn: app.modifiedOn, record },
  });
  expect(commands[2]).toEqual({
    action: "dns-delete",
    dns: {
      zone,
      id: "a1",
      modifiedOn: app.modifiedOn,
      confirm: "app.example.com",
    },
  });
  expect(commands[3]).toEqual({
    action: "dns-create",
    dns: { zone, record, absent: true },
  });
  expect(
    fixDescription({ op: "create", zone, record, overrides: "*.example.com" }),
  ).toBe(
    "Adds an A record app.example.com -> 100.64.0.7, DNS only, which answers for it instead of *.example.com.",
  );
});

test("a delete is confirmed only by the record's full name; the filter matches name, type, content and comment", () => {
  expect(deleteConfirmed("app", app)).toBe(false);
  expect(deleteConfirmed(" App.Example.com. ", app)).toBe(true);
  const txt = {
    ...app,
    id: "t1",
    name: "example.com",
    type: "TXT",
    content: "v=spf1 -all",
    comment: undefined,
  };
  expect(filterRecords([app, txt], "spf").map((each) => each.id)).toEqual([
    "t1",
  ]);
  expect(filterRecords([app, txt], "WEB").map((each) => each.id)).toEqual([
    "a1",
  ]);
  expect(filterRecords([app, txt], " ")).toHaveLength(2);
});

test("without a proxy section or a token the DNS section says what is missing and the steps that set it up", () => {
  expect(dnsSetup({ code: "DNS_UNCONFIGURED", message: "x" })).toMatchObject({
    title: "DNS needs Rig's own Caddy",
    steps: [
      expect.stringContaining("proxy section"),
      expect.stringContaining("rig proxy token"),
      "Run rigd install.",
    ],
  });
  expect(
    dnsSetup({ code: "DNS_TOKEN", message: "No DNS API token is stored." })
      .steps[1],
  ).toContain("Zone:DNS:Edit");
  expect(
    dnsSetup({ code: "DNS_TIMEOUT", message: "slow", hint: "retry" }),
  ).toEqual({
    title: "DNS records could not be read",
    steps: ["slow", "retry"],
  });
});

test("a new record says the name was free only when the page showed no record of its name and type", () => {
  const record = {
    name: "app.example.com",
    type: "A" as const,
    content: "100.64.0.7",
    ttl: 1,
    proxied: false,
  };
  expect(saveCommand(zone, record, undefined, [app])).toEqual({
    action: "dns-create",
    dns: { zone, record },
  });
  expect(
    saveCommand(zone, { ...record, name: "new.example.com" }, undefined, [app]),
  ).toEqual({
    action: "dns-create",
    dns: { zone, record: { ...record, name: "new.example.com" }, absent: true },
  });
});

test("the dashboard's delete action passes on only a delete that carries the record as read and the typed name", () => {
  const command = {
    action: "dns-delete" as const,
    dns: {
      zone,
      id: "a1",
      modifiedOn: app.modifiedOn,
      confirm: "app.example.com",
    },
  };
  expect(confirmedDnsDelete(command)).toEqual({ ok: true, command });
  for (const confirm of [undefined, "", "   "])
    expect(
      confirmedDnsDelete({ ...command, dns: { ...command.dns, confirm } }),
    ).toMatchObject({ ok: false, failure: { code: "DNS_CONFIRMATION" } });
  expect(
    confirmedDnsDelete({ action: "dns-update", dns: command.dns }),
  ).toMatchObject({
    ok: false,
    failure: { code: "INVALID_REQUEST" },
  });
  expect(
    confirmedDnsDelete({ ...command, dns: { ...command.dns, id: "../x" } }),
  ).toMatchObject({ ok: false });
  expect(DNS_DELETE_ELSEWHERE.code).toBe("DNS_CONFIRMATION");
});

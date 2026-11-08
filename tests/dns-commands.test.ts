import { expect, test } from "bun:test";
import { renderResult } from "../src/cli/output";
import { cliHarness, recordedInLog } from "./support/cli-harness";
import type { CliInteraction } from "../src/cli/interaction";
import { chooseZone, planSet } from "../src/cli/dns-plan";

const MAC = "100.64.0.7";
const REPORT = {
  provider: "cloudflare",
  address: MAC,
  addressSource: "tailscale",
  zones: [
    { id: "z1", name: "example.com", status: "active" },
    { id: "z2", name: "example.org", status: "active" },
  ],
  records: [
    {
      id: "a1",
      zone: "example.com",
      name: "app.example.com",
      type: "A",
      content: "203.0.113.5",
      ttl: 300,
      proxied: false,
      modifiedOn: "m-a1",
    },
    {
      id: "t1",
      zone: "example.com",
      name: "_dmarc.example.com",
      type: "TXT",
      content: "v=DMARC1; p=none",
      ttl: 1,
      modifiedOn: "m-t1",
    },
    {
      id: "t2",
      zone: "example.com",
      name: "_dmarc.example.com",
      type: "TXT",
      content: "v=other",
      ttl: 1,
      modifiedOn: "m-t2",
    },
    {
      id: "m1",
      zone: "example.com",
      name: "example.com",
      type: "MX",
      content: "mail.example.com",
      ttl: 1,
      priority: 20,
      modifiedOn: "m-m1",
    },
  ],
  hostnames: [
    {
      hostname: "app.example.com",
      sources: [{ kind: "target", project: "demo", target: "stable" }],
      zone: "example.com",
      verdict: "elsewhere",
      wildcard: false,
      chain: [],
      addresses: [{ type: "A", content: "203.0.113.5" }],
      reason: `It points at 203.0.113.5, not this Mac (${MAC}).`,
      fix: {
        op: "update",
        zone: "example.com",
        id: "a1",
        modifiedOn: "m-a1",
        from: "203.0.113.5",
        record: {
          name: "app.example.com",
          type: "A",
          content: MAC,
          ttl: 300,
          proxied: false,
        },
      },
    },
    {
      hostname: "www.example.com",
      sources: [{ kind: "route" }],
      zone: "example.com",
      verdict: "mac",
      wildcard: true,
      answeredBy: "*.example.com",
      chain: [],
      addresses: [{ type: "A", content: MAC }],
      reason:
        "Covered only by the wildcard *.example.com, which points at this Mac.",
    },
  ],
};

/** Drives the CLI with an injected client that answers the dns read with REPORT, or the report given; no daemon, filesystem
 * or terminal. */
function harness(
  options: { interaction?: CliInteraction; report?: unknown } = {},
) {
  const cli = cliHarness({
    command: (request) =>
      request.action === "dns"
        ? (options.report ?? REPORT)
        : {
            outcome: "updated",
            summary:
              "updated A app.example.com -> 100.64.0.7 (was 203.0.113.5)",
          },
    status: () => ({ project: "demo", targets: [] }),
    record: recordedInLog,
    ...(options.interaction ? { interaction: options.interaction } : {}),
  });
  return {
    ...cli,
    writes: () => cli.requests.filter((request) => request.action !== "dns"),
  };
}
const asked = (answer: boolean) => {
  const questions: string[] = [];
  return {
    questions,
    interaction: {
      async text() {
        return "";
      },
      async confirm(message: string) {
        questions.push(message);
        return answer;
      },
    },
  };
};

test("rig dns list reads every zone, or one, and every dns subcommand answers --help and -h", async () => {
  const h = harness();
  expect(await h.run(["dns", "list"])).toBe(0);
  expect(await h.run(["dns", "list", "Example.COM", "--json"])).toBe(0);
  expect(h.requests).toEqual([
    { action: "dns", repoPath: "/workspace", operationId: "op-1" },
    {
      action: "dns",
      repoPath: "/workspace",
      dns: { zone: "example.com" },
      operationId: "op-1",
    },
  ]);
  for (const args of [
    ["dns", "--help"],
    ["dns", "-h"],
    ["dns", "list", "-h"],
    ["dns", "set", "--help"],
    ["dns", "delete", "-h"],
  ])
    expect(await harness().run(args)).toBe(0);
});

test("rig dns set changes the one record of that name and type, keeping what is not given, once confirmed", async () => {
  const { interaction, questions } = asked(true);
  const h = harness({ interaction });
  expect(
    await h.run(["dns", "set", "app", "a", MAC, "--zone", "example.com"]),
  ).toBe(0);
  expect(questions).toEqual([
    `Change A app.example.com -> 203.0.113.5, TTL 300 to A app.example.com -> ${MAC}, TTL 300?`,
  ]);
  expect(h.writes()).toEqual([
    {
      action: "dns-update",
      repoPath: "/workspace",
      operationId: "op-1",
      dns: {
        zone: "example.com",
        id: "a1",
        modifiedOn: "m-a1",
        record: {
          name: "app.example.com",
          type: "A",
          content: MAC,
          ttl: 300,
          proxied: false,
        },
      },
    },
  ]);
  expect(h.out()).toBe(
    `Updated A app.example.com -> ${MAC} (was 203.0.113.5).\n`,
  );
});

test("rig dns set creates a missing record expecting the name still free, in the zone the name ends in", async () => {
  const h = harness();
  expect(
    await h.run([
      "dns",
      "set",
      "new.example.org",
      "CNAME",
      "App.Example.com.",
      "--ttl",
      "600",
      "--yes",
    ]),
  ).toBe(0);
  expect(h.writes()).toEqual([
    {
      action: "dns-create",
      repoPath: "/workspace",
      operationId: "op-1",
      dns: {
        zone: "example.org",
        absent: true,
        record: {
          name: "new.example.org",
          type: "CNAME",
          content: "app.example.com",
          ttl: 600,
          proxied: false,
        },
      },
    },
  ]);
  const mx = harness();
  expect(
    await mx.run([
      "dns",
      "set",
      "@",
      "MX",
      "mail.example.com",
      "--zone",
      "example.com",
      "--priority",
      "5",
      "-y",
    ]),
  ).toBe(0);
  expect(mx.writes()[0]!.dns).toMatchObject({
    id: "m1",
    record: { name: "example.com", priority: 5 },
  });
});

test("rig dns set writes nothing when the record is already so, when unconfirmed, without a terminal, or when it cannot tell which", async () => {
  const same = harness();
  expect(
    await same.run([
      "dns",
      "set",
      "app.example.com",
      "A",
      "203.0.113.5",
      "--yes",
    ]),
  ).toBe(0);
  expect(same.out()).toBe("A app.example.com -> 203.0.113.5 is already set.\n");

  const declined = asked(false);
  const no = harness({ interaction: declined.interaction });
  expect(await no.run(["dns", "set", "app.example.com", "A", MAC])).toBe(1);
  expect(no.err()).toContain("No DNS record was changed.");

  const headless = harness();
  expect(await headless.run(["dns", "set", "app.example.com", "A", MAC])).toBe(
    1,
  );
  expect(headless.err()).toContain("pass --yes");

  const ambiguous = harness();
  expect(
    await ambiguous.run([
      "dns",
      "set",
      "_dmarc.example.com",
      "TXT",
      "v=new",
      "--replace",
      "--yes",
    ]),
  ).toBe(1);
  expect(ambiguous.err()).toContain("_dmarc.example.com has 2 TXT records");
  expect(ambiguous.err()).toContain("--add");

  const invalid = harness();
  expect(
    await invalid.run([
      "dns",
      "set",
      "app.example.com",
      "A",
      "not-an-ip",
      "--yes",
    ]),
  ).toBe(1);
  expect(invalid.err()).toContain("must be an IPv4 address");

  const unsure = harness();
  expect(await unsure.run(["dns", "set", "app", "A", MAC, "--yes"])).toBe(1);
  expect(unsure.err()).toContain(
    "pass --zone with one of example.com, example.org",
  );

  const unknownZone = harness();
  expect(
    await unknownZone.run([
      "dns",
      "set",
      "app",
      "A",
      MAC,
      "--zone",
      "nope.test",
      "--yes",
    ]),
  ).toBe(1);
  expect(unknownZone.err()).toContain("Rig does not manage the zone nope.test");

  for (const h of [same, no, headless, ambiguous, invalid, unsure, unknownZone])
    expect(h.writes()).toEqual([]);

  const added = harness();
  expect(
    await added.run([
      "dns",
      "set",
      "_dmarc.example.com",
      "TXT",
      "v=new",
      "--add",
      "--yes",
    ]),
  ).toBe(0);
  expect(added.writes()[0]).toMatchObject({
    action: "dns-create",
    dns: { record: { content: "v=new" } },
  });
  expect(added.writes()[0]!.dns!.absent).toBeUndefined();
});

test("rig dns delete deletes the one record of that name and type as it was read; several need --content", async () => {
  const { interaction, questions } = asked(true);
  const h = harness({ interaction });
  expect(await h.run(["dns", "delete", "app.example.com", "A"])).toBe(0);
  expect(questions).toEqual([
    "Delete A app.example.com -> 203.0.113.5, TTL 300?",
  ]);
  expect(h.writes()).toEqual([
    {
      action: "dns-delete",
      repoPath: "/workspace",
      operationId: "op-1",
      dns: {
        zone: "example.com",
        id: "a1",
        modifiedOn: "m-a1",
        confirm: "app.example.com",
      },
    },
  ]);

  const several = harness();
  expect(
    await several.run([
      "dns",
      "delete",
      "_dmarc",
      "TXT",
      "--zone",
      "example.com",
      "--yes",
    ]),
  ).toBe(1);
  expect(several.err()).toContain("Pick one with --content");
  expect(several.writes()).toEqual([]);
  const picked = harness();
  expect(
    await picked.run([
      "dns",
      "delete",
      "_dmarc.example.com",
      "TXT",
      "--content",
      "v=other",
      "--yes",
    ]),
  ).toBe(0);
  expect(picked.writes()[0]!.dns).toEqual({
    zone: "example.com",
    id: "t2",
    modifiedOn: "m-t2",
    confirm: "_dmarc.example.com",
  });
  const none = harness();
  expect(
    await none.run(["dns", "delete", "nothing.example.com", "A", "--yes"]),
  ).toBe(1);
  expect(none.err()).toContain("nothing.example.com has no A record");
});

test("a name is placed in the zone it ends in, else the only zone, else --zone must say", () => {
  const one = { zones: [{ id: "z1", name: "example.com" }] };
  expect(chooseZone(one, "app", undefined)).toBe("example.com");
  expect(chooseZone(one, "@", undefined)).toBe("example.com");
  expect(chooseZone(REPORT, "a.b.example.org", undefined)).toBe("example.org");
  expect(chooseZone(REPORT, "app", "Example.ORG")).toBe("example.org");
  expect(() => chooseZone(REPORT, "app", undefined)).toThrow(
    "in none of the zones",
  );
});

test("rig dns set adds TXT, MX and CAA records beside those there unless --replace, and compares TXT as Cloudflare quotes it", async () => {
  const added = harness();
  expect(
    await added.run([
      "dns",
      "set",
      "_dmarc.example.com",
      "TXT",
      "v=new",
      "--yes",
    ]),
  ).toBe(0);
  expect(added.writes()[0]).toMatchObject({
    action: "dns-create",
    dns: { record: { type: "TXT", content: "v=new" } },
  });
  expect(added.writes()[0]!.dns!.absent).toBeUndefined();

  const quoted = harness();
  expect(
    await quoted.run([
      "dns",
      "set",
      "_dmarc.example.com",
      "TXT",
      '"v=DMARC1; p=none"',
      "--yes",
    ]),
  ).toBe(0);
  expect(quoted.out()).toContain("is already set");
  expect(quoted.writes()).toEqual([]);

  const mx = harness();
  expect(
    await mx.run([
      "dns",
      "set",
      "example.com",
      "MX",
      "backup.example.com",
      "--priority",
      "30",
      "--yes",
    ]),
  ).toBe(0);
  expect(mx.writes()[0]).toMatchObject({
    action: "dns-create",
    dns: { record: { content: "backup.example.com", priority: 30 } },
  });
  const replaced = harness();
  expect(
    await replaced.run([
      "dns",
      "set",
      "example.com",
      "MX",
      "backup.example.com",
      "--replace",
      "--yes",
    ]),
  ).toBe(0);
  expect(replaced.writes()[0]).toMatchObject({
    action: "dns-update",
    dns: { id: "m1", record: { priority: 20 } },
  });

  const both = harness();
  expect(
    await both.run([
      "dns",
      "set",
      "example.com",
      "MX",
      "x.example.com",
      "--add",
      "--replace",
      "--yes",
    ]),
  ).toBe(1);
  expect(both.err()).toContain("--add and --replace ask for opposite things");
});

test("rig dns set refuses a record beside a CNAME, and a CNAME beside any record, before asking rigd", () => {
  const cname = {
    id: "c1",
    zone: "example.com",
    name: "www.example.com",
    type: "CNAME",
    content: "app.example.com",
    ttl: 1,
    modifiedOn: "m",
  };
  const want =
    (type: "A" | "CNAME" | "TXT", content: string, name = "www.example.com") =>
    () =>
      planSet(
        REPORT.records.concat(cname).filter((record) => record.name === name),
        { zone: "example.com", name, type, content },
        {},
      );
  expect(want("A", MAC)).toThrow(
    "www.example.com is a CNAME to app.example.com",
  );
  expect(want("TXT", "x")).toThrow("a CNAME cannot share its name");
  expect(want("CNAME", "other.example.com", "app.example.com")).toThrow(
    "app.example.com already has A 203.0.113.5",
  );
  // Changing the CNAME itself is an update, not a conflict.
  expect(want("CNAME", "other.example.com")()).toMatchObject({
    op: "update",
    current: { id: "c1" },
  });
});

test("with one zone, a one-label name is relative to it, but a dotted name outside it needs --zone", () => {
  const one = { zones: [{ id: "z1", name: "example.com" }] };
  expect(chooseZone(one, "_dmarc", undefined)).toBe("example.com");
  expect(() => chooseZone(one, "www.other.org", undefined)).toThrow(
    "www.other.org is in none of the zones Rig manages.",
  );
  expect(chooseZone(one, "api.melody", "example.com")).toBe("example.com");
});

test("rig dns list shows each zone's records and every served hostname, with the command that points it here", () => {
  const text = renderResult("dns", REPORT);
  expect(text).toContain(`This Mac   ${MAC} (Tailscale)`);
  expect(text).toContain("example.com  4 records");
  expect(text).toMatch(/app\.example\.com\s+A\s+203\.0\.113\.5 {2}\(ttl 300\)/);
  expect(text).toMatch(
    /example\.com\s+MX\s+mail\.example\.com {2}\(priority 20, ttl auto\)/,
  );
  expect(text).toContain("FIX    app.example.com  It points at 203.0.113.5");
  expect(text).toContain(`rig dns set app.example.com A ${MAC} --no-proxied`);
  expect(text).toContain(
    "ok     www.example.com  Covered only by the wildcard *.example.com, which points at this Mac.",
  );
});

const dnsRecord = (
  zone: string,
  id: string,
  type: string,
  content: string,
  name = "app.sub.example.co.uk",
  fields: Record<string, unknown> = {},
) => ({
  id,
  zone,
  name,
  type,
  content,
  ttl: 300,
  ...(["A", "AAAA", "CNAME"].includes(type) ? { proxied: false } : {}),
  modifiedOn: `m-${id}`,
  ...fields,
});
const PARENT = "example.co.uk";
const CHILD = "sub.example.co.uk";
/** A parent zone and the child zone split from it, each with whatever records the case gives it. */
const overlapping = (
  ...records: ReturnType<typeof dnsRecord>[]
): Record<string, unknown> => ({
  provider: "cloudflare",
  zones: [
    { id: "parent", name: PARENT, status: "active" },
    { id: "child", name: CHILD, status: "active" },
  ],
  records,
  hostnames: [],
});
const NAME = "app.sub.example.co.uk";

test("rig dns set plans against the child zone's own records, never the parent's record of the same name", async () => {
  const { writes, run, out } = harness({
    report: overlapping(
      dnsRecord(PARENT, "p1", "A", MAC),
      dnsRecord(CHILD, "c1", "A", "203.0.113.9"),
    ),
  });
  // The parent's record already says this; the child's, which answers, does not.
  expect(await run(["dns", "set", NAME, "A", MAC, "--yes"])).toBe(0);
  expect(out()).not.toContain("is already set");
  expect(writes()).toMatchObject([
    {
      action: "dns-update",
      dns: {
        zone: CHILD,
        id: "c1",
        modifiedOn: "m-c1",
        record: { name: NAME, content: MAC },
      },
    },
  ]);
});

test("rig dns set leaves a child record that already says it, whatever the parent's says", async () => {
  const { writes, run, out } = harness({
    report: overlapping(
      dnsRecord(PARENT, "p1", "A", "203.0.113.9"),
      dnsRecord(CHILD, "c1", "A", MAC),
    ),
  });
  expect(await run(["dns", "set", NAME, "A", MAC, "--yes"])).toBe(0);
  expect(out()).toContain("is already set");
  expect(writes()).toEqual([]);
});

test("rig dns set creates in the child zone when only the parent holds the name, however many it holds", async () => {
  const { writes, run } = harness({
    report: overlapping(
      dnsRecord(PARENT, "p1", "A", "203.0.113.8"),
      dnsRecord(PARENT, "p2", "A", "203.0.113.9"),
    ),
  });
  expect(await run(["dns", "set", NAME, "A", MAC, "--yes"])).toBe(0);
  expect(writes()).toMatchObject([
    {
      action: "dns-create",
      dns: { zone: CHILD, absent: true, record: { name: NAME, content: MAC } },
    },
  ]);
});

test("--zone picks the parent's record over the child's, and the child's over the parent's, for set and delete", async () => {
  const report = overlapping(
    dnsRecord(PARENT, "p1", "A", "203.0.113.8"),
    dnsRecord(CHILD, "c1", "A", "203.0.113.9"),
  );
  const set = harness({ report });
  expect(
    await set.run(["dns", "set", NAME, "A", MAC, "--zone", PARENT, "--yes"]),
  ).toBe(0);
  expect(set.writes()).toMatchObject([
    { action: "dns-update", dns: { zone: PARENT, id: "p1" } },
  ]);

  const child = harness({ report });
  expect(
    await child.run(["dns", "delete", NAME, "A", "--zone", CHILD, "--yes"]),
  ).toBe(0);
  expect(child.writes()).toMatchObject([
    {
      action: "dns-delete",
      dns: { zone: CHILD, id: "c1", modifiedOn: "m-c1", confirm: NAME },
    },
  ]);

  const parent = harness({ report });
  expect(
    await parent.run(["dns", "delete", NAME, "A", "--zone", PARENT, "--yes"]),
  ).toBe(0);
  expect(parent.writes()).toMatchObject([
    { action: "dns-delete", dns: { zone: PARENT, id: "p1" } },
  ]);

  // The other zone's content is not in this zone, so nothing there matches: an id from one zone is never sent with another.
  const crossed = harness({ report });
  expect(
    await crossed.run([
      "dns",
      "delete",
      NAME,
      "A",
      "--zone",
      PARENT,
      "--content",
      "203.0.113.9",
      "--yes",
    ]),
  ).toBe(1);
  expect(crossed.err()).toContain("has no A record with that content");
  expect(crossed.writes()).toEqual([]);
});

test("a CNAME in the other zone is no conflict: DNS allows nothing beside a CNAME only within one zone", async () => {
  const parentCname = harness({
    report: overlapping(
      dnsRecord(PARENT, "p1", "CNAME", "elsewhere.example.net"),
    ),
  });
  expect(await parentCname.run(["dns", "set", NAME, "A", MAC, "--yes"])).toBe(
    0,
  );
  expect(parentCname.writes()).toMatchObject([
    { action: "dns-create", dns: { zone: CHILD, absent: true } },
  ]);

  const childCname = harness({
    report: overlapping(
      dnsRecord(CHILD, "c1", "CNAME", "elsewhere.example.net"),
    ),
  });
  expect(
    await childCname.run([
      "dns",
      "set",
      NAME,
      "A",
      MAC,
      "--zone",
      PARENT,
      "--yes",
    ]),
  ).toBe(0);
  expect(childCname.writes()).toMatchObject([
    { action: "dns-create", dns: { zone: PARENT, absent: true } },
  ]);
});

test("a change to a name in an unreadable child zone fails with why, and is never planned against or written to the parent", async () => {
  const report = {
    ...overlapping(dnsRecord(PARENT, "p1", "A", MAC)),
    zones: [{ id: "parent", name: PARENT, status: "active" }],
    unreadableZones: [
      { zone: CHILD, code: "DNS_AUTH", message: "Cloudflare refused it." },
    ],
  };
  for (const args of [
    ["dns", "set", NAME, "A", MAC, "--yes"],
    ["dns", "set", "app", "A", MAC, "--zone", CHILD, "--yes"],
    ["dns", "delete", NAME, "A", "--yes"],
    ["dns", "delete", NAME, "A", "--zone", CHILD, "--yes"],
  ]) {
    const h = harness({ report });
    expect(await h.run(args)).toBe(1);
    expect(h.err()).toContain(`The records of ${CHILD} could not be read`);
    expect(h.err()).toContain("Cloudflare refused it.");
    expect(h.writes()).toEqual([]);
  }
  // It fails with the zone's own code, not one of its own.
  expect(() => chooseZone(report, NAME, undefined)).toThrow(
    expect.objectContaining({ code: "DNS_AUTH" }),
  );
  // With its zone named, the parent's own record is still the owner's to change.
  const h = harness({ report });
  expect(
    await h.run(["dns", "delete", NAME, "A", "--zone", PARENT, "--yes"]),
  ).toBe(0);
  expect(h.writes()).toMatchObject([{ dns: { zone: PARENT, id: "p1" } }]);
  // A one-label name is relative to the only zone, but there are two here even with one of them unreadable.
  const bare = harness({ report });
  expect(await bare.run(["dns", "set", "app", "A", MAC, "--yes"])).toBe(1);
  expect(bare.err()).toContain("or it could be in several");
  expect(bare.writes()).toEqual([]);
});

test("a null MX can be created with rig dns set, and its TTL changed, keeping its root exchange and preference 0", async () => {
  const created = harness({ report: overlapping() });
  expect(
    await created.run(["dns", "set", "@", "MX", ".", "--zone", CHILD, "--yes"]),
  ).toBe(0);
  expect(created.writes()).toMatchObject([
    {
      action: "dns-create",
      dns: {
        zone: CHILD,
        record: { name: CHILD, type: "MX", content: ".", priority: 0 },
      },
    },
  ]);

  const stored = dnsRecord(CHILD, "mx1", "MX", ".", CHILD, { priority: 0 });
  const edited = harness({ report: overlapping(stored) });
  expect(
    await edited.run([
      "dns",
      "set",
      "@",
      "MX",
      ".",
      "--zone",
      CHILD,
      "--ttl",
      "600",
      "--yes",
    ]),
  ).toBe(0);
  expect(edited.writes()).toMatchObject([
    {
      action: "dns-update",
      dns: {
        zone: CHILD,
        id: "mx1",
        record: { type: "MX", content: ".", priority: 0, ttl: 600 },
      },
    },
  ]);

  const same = harness({ report: overlapping(stored) });
  expect(
    await same.run(["dns", "set", "@", "MX", ".", "--zone", CHILD, "--yes"]),
  ).toBe(0);
  expect(same.out()).toContain("is already set");

  const refused = harness({ report: overlapping() });
  expect(
    await refused.run([
      "dns",
      "set",
      "@",
      "MX",
      ".",
      "--zone",
      CHILD,
      "--priority",
      "10",
      "--yes",
    ]),
  ).toBe(1);
  expect(refused.err()).toContain("priority must be 0 for a null MX");
  expect(refused.writes()).toEqual([]);
});

test("a long TXT record Cloudflare stored can have its TTL changed, with its content as it is", async () => {
  // 2048 bytes of text in strings of 255: 2057 bytes in DNS, 2074 characters as written.
  const content = [
    ...Array.from({ length: 8 }, () => `"${"x".repeat(255)}"`),
    '"xxxxxxxx"',
  ].join(" ");
  const name = "dkim.example.co.uk";
  const { writes, run } = harness({
    report: overlapping(dnsRecord(PARENT, "t1", "TXT", content, name)),
  });
  expect(
    await run(["dns", "set", name, "TXT", content, "--ttl", "600", "--yes"]),
  ).toBe(0);
  expect(writes()).toMatchObject([
    {
      action: "dns-update",
      dns: {
        zone: PARENT,
        id: "t1",
        record: { type: "TXT", content, ttl: 600 },
      },
    },
  ]);
});

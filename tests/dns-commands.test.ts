import { expect, test } from "bun:test";
import type { RuntimeCommand } from "../src/daemon/protocol";
import { runRigCli } from "../src/cli/rig";
import { renderResult } from "../src/cli/output";
import type { CliInteraction } from "../src/cli/interaction";
import { chooseZone, planSet } from "../src/cli/dns-command";

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

/** Drives the CLI with an injected client that answers the dns read with REPORT; no daemon, filesystem or terminal. */
function harness(options: { interaction?: CliInteraction } = {}) {
  const requests: RuntimeCommand[] = [];
  let out = "";
  let err = "";
  const deps = {
    root: "/isolated/.rig",
    cwd: "/workspace",
    client: {
      async status() {
        return { project: "demo", targets: [] };
      },
      async command(request: RuntimeCommand) {
        requests.push(request);
        return request.action === "dns"
          ? REPORT
          : {
              outcome: "updated",
              summary:
                "updated A app.example.com -> 100.64.0.7 (was 203.0.113.5)",
            };
      },
    },
    output: {
      write(value: string) {
        out += value;
      },
      error(value: string) {
        err += value;
      },
    },
    diagnostics: {
      async record() {
        return { path: "/isolated/.rig/logs/rig/rig.jsonl" };
      },
    },
    wait: async () => {},
    newOperationId: () => "op-1",
    ...(options.interaction ? { interaction: options.interaction } : {}),
  };
  return {
    deps,
    run: (args: string[]) => runRigCli(args, deps as never),
    writes: () => requests.filter((request) => request.action !== "dns"),
    requests,
    out: () => out,
    err: () => err,
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

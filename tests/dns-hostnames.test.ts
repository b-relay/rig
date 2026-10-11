import { expect, test } from "bun:test";
import {
  MAX_HOPS,
  POINT_COMMENT,
  checkHostnames,
  delegation,
  lookupName,
  type ServedHostname,
} from "../src/domain/dns-hostnames";
import type { DnsRecord, DnsZone } from "../src/domain/dns-records";
import { targetHostnames } from "../src/runtime/dns-hostnames";

const MAC = "100.64.0.7";
const zones: DnsZone[] = [
  { id: "z1", name: "example.com", status: "active" },
  { id: "z2", name: "example.org", status: "active" },
];
let ids = 0;
const record = (
  name: string,
  type: string,
  content: string,
  extra: Partial<DnsRecord> = {},
): DnsRecord => ({
  id: `r${++ids}`,
  zone: name.endsWith("example.org") ? "example.org" : "example.com",
  name,
  type,
  content,
  ttl: 1,
  proxied: false,
  modifiedOn: `2026-10-01T00:00:${String(ids).padStart(2, "0")}Z`,
  ...extra,
});
const served = (...hostnames: string[]): ServedHostname[] =>
  hostnames.map((hostname) => ({
    hostname,
    sources: [{ kind: "target", project: "demo", target: "stable" }],
  }));
const check = (
  records: DnsRecord[],
  hostname: string,
  mac: { address?: string } = { address: MAC },
) =>
  checkHostnames({
    hostnames: served(hostname),
    zones,
    records,
    address: mac.address,
  })[0]!;

test("a name's own A record answers; this Mac's address unproxied is a match", () => {
  const records = [record("app.example.com", "A", MAC)];
  expect(check(records, "app.example.com")).toMatchObject({
    verdict: "mac",
    wildcard: false,
    answeredBy: "app.example.com",
    reason: "Points at this Mac.",
    addresses: [{ type: "A", content: MAC }],
  });
  expect(check(records, "app.example.com").fix).toBeUndefined();
});

test("a name covered only by a wildcard points at this Mac when the wildcard does, at any depth below an empty parent", () => {
  const records = [record("*.example.com", "A", MAC)];
  for (const hostname of ["app.example.com", "api.app.example.com"]) {
    const result = check(records, hostname);
    expect(result).toMatchObject({
      verdict: "mac",
      wildcard: true,
      answeredBy: "*.example.com",
    });
    expect(result.reason).toBe(
      "Covered only by the wildcard *.example.com, which points at this Mac.",
    );
  }
});

test("wildcards follow DNS: the closest existing parent's wildcard answers, an empty non-terminal gets none, and own records win", () => {
  const records = [
    record("*.example.com", "A", MAC),
    record("melody.example.com", "A", MAC),
    record("*.melody.example.com", "A", "203.0.113.9"),
    // An ACME challenge left under rig makes rig.example.com exist with no data, so *.example.com does not answer for it.
    record("_acme-challenge.rig.example.com", "TXT", "token-proof"),
    record("mail.example.com", "TXT", "v=spf1 -all"),
  ];
  expect(check(records, "api.melody.example.com")).toMatchObject({
    verdict: "elsewhere",
    wildcard: true,
    answeredBy: "*.melody.example.com",
  });
  expect(check(records, "rig.example.com")).toMatchObject({
    verdict: "missing",
    wildcard: false,
  });
  expect(check(records, "rig.example.com").reason).toContain(
    "exists only as the parent of other records",
  );
  expect(check(records, "mail.example.com")).toMatchObject({
    verdict: "missing",
    reason: "It has records, but no A record.",
  });
  expect(lookupName("other.example.com", "example.com", records)).toMatchObject(
    { kind: "records", owner: "*.example.com" },
  );
  expect(lookupName("x.example.com", "example.com", [])).toEqual({
    kind: "nxdomain",
  });
});

test("a wildcard that points elsewhere is overridden by a new A record, which Point at this Mac creates", () => {
  const records = [record("*.example.com", "A", "203.0.113.5")];
  const result = check(records, "app.example.com");
  expect(result).toMatchObject({ verdict: "elsewhere", wildcard: true });
  expect(result.reason).toContain(
    "The wildcard *.example.com points at 203.0.113.5, not this Mac (100.64.0.7).",
  );
  expect(result.fix).toEqual({
    op: "create",
    zone: "example.com",
    overrides: "*.example.com",
    record: {
      name: "app.example.com",
      type: "A",
      content: MAC,
      ttl: 1,
      proxied: false,
      comment: POINT_COMMENT,
    },
  });
});

test("a missing name gets a new A record; one A record elsewhere or proxied is rewritten in place, keeping its TTL and comment", () => {
  expect(check([], "new.example.com")).toMatchObject({
    verdict: "missing",
    fix: { op: "create", record: { name: "new.example.com", content: MAC } },
  });
  const old = record("app.example.com", "A", "203.0.113.5", {
    ttl: 300,
    comment: "old host",
  });
  expect(check([old], "app.example.com").fix).toEqual({
    op: "update",
    zone: "example.com",
    id: old.id,
    modifiedOn: old.modifiedOn,
    from: "203.0.113.5",
    record: {
      name: "app.example.com",
      type: "A",
      content: MAC,
      ttl: 300,
      proxied: false,
      comment: "old host",
    },
  });
  const proxied = record("cdn.example.com", "A", MAC, { proxied: true });
  const result = check([proxied], "cdn.example.com");
  expect(result.verdict).toBe("elsewhere");
  expect(result.reason).toContain("proxied through Cloudflare");
  expect(result.fix).toMatchObject({
    op: "update",
    from: `${MAC} (proxied)`,
    record: { proxied: false },
  });
});

test("CNAMEs are followed inside the zones Rig manages; one leaving them is unknown; none is offered a one-click fix", () => {
  const records = [
    record("www.example.com", "CNAME", "app.example.org"),
    record("app.example.org", "A", MAC),
    record("ext.example.com", "CNAME", "elsewhere.example.net"),
    record("loop.example.com", "CNAME", "loop2.example.com"),
    record("loop2.example.com", "CNAME", "loop.example.com"),
  ];
  const www = check(records, "www.example.com");
  expect(www).toMatchObject({
    verdict: "mac",
    chain: ["www.example.com -> app.example.org"],
  });
  expect(www.fix).toBeUndefined();
  const external = check(records, "ext.example.com");
  expect(external).toMatchObject({ verdict: "unknown" });
  expect(external.reason).toContain("outside the zones Rig manages");
  expect(external.fixBlocked).toContain("is a CNAME to elsewhere.example.net");
  expect(check(records, "loop.example.com").reason).toContain(
    "longer than 8 hops or loops",
  );
});

test("several A records, an unknown Mac address and a name outside every zone offer no fix and say why", () => {
  const records = [
    record("rr.example.com", "A", "203.0.113.1"),
    record("rr.example.com", "A", "203.0.113.2"),
  ];
  expect(check(records, "rr.example.com").fixBlocked).toBe(
    "rr.example.com has 2 A records; edit or delete them in the records below.",
  );
  const unknown = check(
    [record("app.example.com", "A", MAC)],
    "app.example.com",
    {},
  );
  expect(unknown.verdict).toBe("unknown");
  expect(unknown.fixBlocked).toContain("proxy.dns.address");
  const outside = check([], "app.example.net");
  expect(outside).toMatchObject({
    verdict: "unknown",
    reason:
      "No zone Rig manages holds this name, so Rig cannot tell where it points.",
  });
  expect(outside.zone).toBeUndefined();
  expect(outside.fix).toBeUndefined();
});

test("served hostnames come from every recorded Target's plan, bare and once each, with every Target that serves them", () => {
  const plan = (domain?: string) =>
    ({
      ...(domain ? { domain } : {}),
      proxy: {
        upstream: "web",
        routes: [{ prefix: "/", service: "web", port: 3000 }],
      },
      components: [],
    }) as never;
  const hostnames = targetHostnames({
    projects: [{ id: "p1", name: "demo" }] as never,
    targets: [
      {
        projectId: "p1",
        name: "stable",
        plan: plan("https://App.example.com:8443"),
      },
      { projectId: "p1", name: "feat-x", plan: plan("app-feat-x.example.com") },
      { projectId: "p1", name: "working", plan: plan("demo.localhost") },
      { projectId: "p1", name: "other", plan: plan() },
    ] as never,
  });
  expect(hostnames).toEqual([
    {
      hostname: "app.example.com",
      sources: [{ kind: "target", project: "demo", target: "stable" }],
    },
    {
      hostname: "app-feat-x.example.com",
      sources: [{ kind: "target", project: "demo", target: "feat-x" }],
    },
  ]);
});

test("a name delegated to other nameservers below the apex is unknown, with no fix offered", () => {
  const records = [
    record("*.example.com", "A", MAC),
    record("lab.example.com", "NS", "ns1.elsewhere.net"),
    record("lab.example.com", "NS", "ns2.elsewhere.net"),
    record("go.example.com", "CNAME", "box.lab.example.com"),
  ];
  for (const hostname of ["lab.example.com", "api.lab.example.com"]) {
    const result = check(records, hostname);
    expect(result).toMatchObject({ verdict: "unknown", zone: "example.com" });
    expect(result.reason).toBe(
      "lab.example.com is delegated to other nameservers (NS records), so example.com's records do not answer for this name.",
    );
    expect(result.fix).toBeUndefined();
    expect(result.fixBlocked).toContain("delegated to");
  }
  expect(delegation("api.lab.example.com", "example.com", records)).toBe(
    "lab.example.com",
  );
  // NS records at the apex are the zone's own and delegate nothing.
  expect(
    delegation("example.com", "example.com", [
      record("example.com", "NS", "ns.cloudflare.com"),
    ]),
  ).toBeUndefined();
  expect(check(records, "go.example.com")).toMatchObject({
    verdict: "unknown",
  });
  expect(check(records, "go.example.com").reason).toContain(
    "which lab.example.com delegates to other nameservers",
  );
});

test("a CNAME into a child zone that could not be read is unknown, even when a parent wildcard points here", () => {
  const child: DnsZone = {
    id: "z3",
    name: "child.example.com",
    status: "active",
  };
  const records = [
    record("*.example.com", "A", MAC),
    record("alias.example.com", "CNAME", "app.child.example.com"),
  ];
  const result = checkHostnames({
    hostnames: served("alias.example.com"),
    zones,
    records,
    address: MAC,
    unreadable: [child],
  })[0]!;
  expect(result.verdict).toBe("unknown");
  expect(result.reason).toBe(
    "It is a CNAME to app.child.example.com, in child.example.com, whose records Rig could not read just now, so Rig cannot tell where that points.",
  );
});

test("a chain of exactly MAX_HOPS CNAMEs reaches its address; one more is too long", () => {
  const chain = (hops: number) => [
    ...Array.from({ length: hops }, (_, index) =>
      record(`c${index}.example.com`, "CNAME", `c${index + 1}.example.com`),
    ),
    record(`c${hops}.example.com`, "A", MAC),
  ];
  const exact = check(chain(MAX_HOPS), "c0.example.com");
  expect(exact).toMatchObject({ verdict: "mac" });
  expect(exact.chain).toHaveLength(MAX_HOPS);
  const over = check(chain(MAX_HOPS + 1), "c0.example.com");
  expect(over).toMatchObject({ verdict: "unknown" });
  expect(over.reason).toBe("Its CNAME chain is longer than 8 hops or loops.");
});

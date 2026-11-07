import { expect, test } from "bun:test";
import {
  MAX_HOPS,
  POINT_COMMENT,
  answeringZone,
  checkHostnames,
  pointFix,
  resolveChain,
  verdictOf,
  type Resolution,
  type ZoneRecords,
} from "../src/domain/dns-hostnames";
import type { DnsRecord, DnsZone } from "../src/domain/dns-records";

const MAC = "100.64.0.7";
const com: DnsZone = { id: "z1", name: "example.com", status: "active" };
const lab: DnsZone = { id: "z2", name: "lab.example.com", status: "active" };
let ids = 0;
const record = (
  name: string,
  type: string,
  content: string,
  extra: Partial<DnsRecord> = {},
): DnsRecord => ({
  id: `r${++ids}`,
  zone: name.endsWith("lab.example.com") ? "lab.example.com" : "example.com",
  name,
  type,
  content,
  ttl: 300,
  proxied: false,
  modifiedOn: "2026-10-01T00:00:00Z",
  ...extra,
});
const view = (
  records: DnsRecord[],
  unreadable: DnsZone[] = [],
): ZoneRecords => ({
  zones: [com, lab].filter((zone) => !unreadable.includes(zone)),
  records,
  unreadable,
});

test("answeringZone names the longest zone that holds the name, or refuses an unmanaged, unread or delegated one", () => {
  expect(answeringZone("app.lab.example.com", view([]))).toEqual({
    zone: "lab.example.com",
  });
  expect(answeringZone("app.example.net", view([]))).toEqual({
    refusal: {
      verdict: "unknown",
      reason:
        "No zone Rig manages holds this name, so Rig cannot tell where it points.",
    },
  });
  // The child zone holds it even unread: its parent never answers instead.
  expect(answeringZone("app.lab.example.com", view([], [lab]))).toEqual({
    refusal: {
      zone: "lab.example.com",
      verdict: "unknown",
      unreadZone: "lab.example.com",
      reason:
        "Rig could not read the records of lab.example.com just now, so it cannot tell where this name points.",
    },
  });
  const ns = record("team.example.com", "NS", "ns1.elsewhere.net");
  expect(answeringZone("api.team.example.com", view([ns]))).toEqual({
    refusal: {
      zone: "example.com",
      verdict: "unknown",
      reason:
        "team.example.com is delegated to other nameservers (NS records), so example.com's records do not answer for this name.",
      fixBlocked:
        "Point it at this Mac at the nameservers team.example.com is delegated to.",
    },
  });
});

test("resolveChain reports the first answer, every hop, and where the walk ends", () => {
  const own = record("app.example.com", "A", MAC);
  expect(resolveChain("app.example.com", "example.com", view([own]))).toEqual({
    kind: "answered",
    first: { owner: "app.example.com", wildcard: false },
    chain: [],
    end: { kind: "addresses", addresses: [{ type: "A", content: MAC }] },
  });
  expect(resolveChain("app.example.com", "example.com", view([]))).toEqual({
    kind: "unanswered",
    lookup: { kind: "nxdomain" },
  });
  // A wildcard answers first; its CNAME crosses into the child zone, whose name answers.
  const records = [
    record("*.example.com", "CNAME", "edge.lab.example.com", { ttl: 60 }),
    record("edge.lab.example.com", "AAAA", "2001:db8::1", { proxied: true }),
  ];
  expect(resolveChain("app.example.com", "example.com", view(records))).toEqual(
    {
      kind: "answered",
      first: { owner: "*.example.com", wildcard: true },
      chain: ["*.example.com -> edge.lab.example.com"],
      end: {
        kind: "addresses",
        addresses: [{ type: "AAAA", content: "2001:db8::1", proxied: true }],
      },
    },
  );
  const ends = (records: DnsRecord[], unreadable: DnsZone[] = []) =>
    (
      resolveChain(
        "app.example.com",
        "example.com",
        view(records, unreadable),
      ) as Extract<Resolution, { kind: "answered" }>
    ).end;
  const to = (target: string, extra: Partial<DnsRecord> = {}) =>
    record("app.example.com", "CNAME", target, extra);
  expect(ends([to("x.example.net")])).toEqual({
    kind: "outside",
    name: "x.example.net",
  });
  expect(ends([to("x.lab.example.com")], [lab])).toEqual({
    kind: "unread",
    name: "x.lab.example.com",
    zone: "lab.example.com",
  });
  expect(
    ends([
      to("api.team.example.com"),
      record("team.example.com", "NS", "ns1.elsewhere.net"),
    ]),
  ).toEqual({
    kind: "delegated",
    name: "api.team.example.com",
    cut: "team.example.com",
  });
  expect(ends([to("gone.example.com")])).toEqual({
    kind: "dangling",
    name: "gone.example.com",
    lookup: { kind: "nxdomain" },
  });
  expect(ends([to("edge.example.com", { proxied: true })])).toEqual({
    kind: "proxied-cname",
  });
});

test("resolveChain follows exactly MAX_HOPS CNAMEs to an address, and stops a loop one hop past them", () => {
  const hops = Array.from({ length: MAX_HOPS }, (_, hop) =>
    record(`c${hop}.example.com`, "CNAME", `c${hop + 1}.example.com`),
  );
  const reached = resolveChain(
    "c0.example.com",
    "example.com",
    view([...hops, record(`c${MAX_HOPS}.example.com`, "A", MAC)]),
  ) as Extract<Resolution, { kind: "answered" }>;
  expect(reached.chain).toHaveLength(MAX_HOPS);
  expect(reached.end.kind).toBe("addresses");
  const loop = resolveChain(
    "a.example.com",
    "example.com",
    view([
      record("a.example.com", "CNAME", "b.example.com"),
      record("b.example.com", "CNAME", "a.example.com"),
    ]),
  ) as Extract<Resolution, { kind: "answered" }>;
  expect(loop.chain).toHaveLength(MAX_HOPS + 1);
  expect(loop.end).toEqual({ kind: "too-long" });
});

test("verdictOf words each end of the walk, naming the name a CNAME leads to", () => {
  const first = { owner: "app.example.com", wildcard: false };
  const answered = (
    end: Extract<Resolution, { kind: "answered" }>["end"],
    chain: string[] = ["app.example.com -> next.example.com"],
  ): Resolution => ({ kind: "answered", first, chain, end });
  expect(
    verdictOf(
      {
        kind: "unanswered",
        lookup: { kind: "nodata", owner: "app.example.com", parentOnly: true },
      },
      MAC,
    ),
  ).toEqual({
    addresses: [],
    verdict: "missing",
    reason:
      "It exists only as the parent of other records, so no wildcard answers for it and it has no address.",
  });
  expect(
    verdictOf(
      answered({
        kind: "dangling",
        name: "next.example.com",
        lookup: { kind: "nxdomain" },
      }),
      MAC,
    ),
  ).toEqual({
    addresses: [],
    verdict: "missing",
    reason:
      "Its CNAME leads to next.example.com, which has no record, and no wildcard covers it.",
  });
  expect(
    verdictOf(
      answered({
        kind: "unread",
        name: "x.lab.example.com",
        zone: "lab.example.com",
      }),
      MAC,
    ),
  ).toEqual({
    addresses: [],
    verdict: "unknown",
    unreadZone: "lab.example.com",
    reason:
      "It is a CNAME to x.lab.example.com, in lab.example.com, whose records Rig could not read just now, so Rig cannot tell where that points.",
  });
  expect(verdictOf(answered({ kind: "too-long" }), MAC)).toMatchObject({
    verdict: "unknown",
    reason: `Its CNAME chain is longer than ${MAX_HOPS} hops or loops.`,
  });
  // Addresses are judged as reached directly or through the chain.
  const addresses = [{ type: "A", content: "203.0.113.9" }];
  expect(
    verdictOf(answered({ kind: "addresses", addresses }, []), MAC),
  ).toEqual({
    addresses,
    verdict: "elsewhere",
    reason: `It points at 203.0.113.9, not this Mac (${MAC}).`,
  });
  expect(
    verdictOf(answered({ kind: "addresses", addresses }), undefined),
  ).toMatchObject({
    verdict: "unknown",
    reason:
      "Its CNAME chain points at 203.0.113.9. Rig does not know this Mac's address: set proxy.dns.address, or install Tailscale.",
  });
});

test("pointFix chooses the repair from the name's own records and this Mac's address", () => {
  const name = {
    hostname: "app.example.com",
    zone: "example.com",
    verdict: "elsewhere" as const,
  };
  expect(pointFix({ ...name, verdict: "mac", own: [] }, MAC)).toEqual({});
  expect(pointFix({ ...name, own: [] }, undefined)).toEqual({
    fixBlocked:
      "Rig does not know this Mac's address: set proxy.dns.address in config.yaml, or install Tailscale.",
  });
  expect(
    pointFix({ ...name, own: [], overrides: "*.example.com" }, MAC),
  ).toEqual({
    fix: {
      op: "create",
      zone: "example.com",
      record: {
        name: "app.example.com",
        type: "A",
        content: MAC,
        ttl: 1,
        proxied: false,
        comment: POINT_COMMENT,
      },
      overrides: "*.example.com",
    },
  });
  const a = record("app.example.com", "A", "203.0.113.9", {
    proxied: true,
    comment: "kept",
  });
  expect(pointFix({ ...name, own: [a] }, MAC)).toEqual({
    fix: {
      op: "update",
      zone: "example.com",
      id: a.id,
      modifiedOn: a.modifiedOn,
      from: "203.0.113.9 (proxied)",
      record: {
        name: "app.example.com",
        type: "A",
        content: MAC,
        ttl: 300,
        proxied: false,
        comment: "kept",
      },
    },
  });
  expect(
    pointFix(
      {
        ...name,
        own: [record("app.example.com", "CNAME", "edge.example.net")],
      },
      MAC,
    ),
  ).toEqual({
    fixBlocked:
      "app.example.com is a CNAME to edge.example.net; edit or delete that record to point the name at this Mac.",
  });
  expect(
    pointFix(
      {
        ...name,
        own: [
          a,
          record("app.example.com", "AAAA", "2001:db8::1", { proxied: true }),
        ],
      },
      MAC,
    ).fixBlocked,
  ).toContain("has a proxied AAAA record");
  expect(
    pointFix({ ...name, own: [a, record("app.example.com", "A", MAC)] }, MAC),
  ).toEqual({
    fixBlocked:
      "app.example.com has 2 A records; edit or delete them in the records below.",
  });
});

test("a batch reports its names in order, each with its own zone, chain and wildcard", () => {
  const sources = [{ kind: "route" as const }];
  const results = checkHostnames({
    hostnames: [
      { hostname: "z.example.com", sources },
      { hostname: "b.lab.example.com", sources },
      { hostname: "a.example.com", sources },
    ],
    zones: [com, lab],
    records: [
      record("a.example.com", "CNAME", "b.lab.example.com"),
      record("*.lab.example.com", "A", MAC),
    ],
    address: MAC,
  });
  expect(
    results.map(({ hostname, zone, chain, wildcard, answeredBy, verdict }) => ({
      hostname,
      zone,
      chain,
      wildcard,
      answeredBy,
      verdict,
    })),
  ).toEqual([
    {
      hostname: "a.example.com",
      zone: "example.com",
      chain: ["a.example.com -> b.lab.example.com"],
      wildcard: false,
      answeredBy: "a.example.com",
      verdict: "mac",
    },
    {
      hostname: "b.lab.example.com",
      zone: "lab.example.com",
      chain: [],
      wildcard: true,
      answeredBy: "*.lab.example.com",
      verdict: "mac",
    },
    {
      hostname: "z.example.com",
      zone: "example.com",
      chain: [],
      wildcard: false,
      answeredBy: undefined,
      verdict: "missing",
    },
  ]);
});

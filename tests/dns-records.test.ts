import { expect, test } from "bun:test";
import {
  dnsRecordInputSchema,
  normalizeRecordInput,
  requestedDnsChange,
  canonicalIpv6,
  contentKey,
  sameContent,
  txtValue,
} from "../src/domain/dns-records";
import { parseHostConfig } from "../src/config";
import { settingsDigest } from "../src/domain/managed-proxy";
import { pendingSettings } from "../src/adapters/proxy-generation";

test("TXT values compare as resolvers assemble them: Cloudflare's quoted and split strings equal the bare text", () => {
  expect(txtValue('"v=spf1 -all"')).toBe("v=spf1 -all");
  expect(txtValue('"v=DKIM1; k=rsa; p=MIIB" "IjANBgkq"')).toBe(
    "v=DKIM1; k=rsa; p=MIIBIjANBgkq",
  );
  expect(txtValue('"say \\"hi\\" \\\\ \\065"')).toBe('say "hi" \\ A');
  expect(txtValue("v=spf1 -all")).toBe("v=spf1 -all");
  // Only content wholly made of quoted strings is unquoted.
  expect(txtValue('v="1"')).toBe('v="1"');
  expect(sameContent("TXT", '"v=spf1 -all"', "v=spf1 -all")).toBe(true);
  expect(sameContent("TXT", '"a" "b"', '"ab"')).toBe(true);
  expect(sameContent("CNAME", "App.Example.com.", "app.example.com")).toBe(
    true,
  );
  expect(sameContent("A", "1.2.3.4", "1.2.3.5")).toBe(false);
});

test("every TTL and comment Cloudflare can store passes, so an edit never fails on a value Rig did not set", () => {
  const base = { name: "a.example.com", type: "A", content: "1.2.3.4" };
  expect(dnsRecordInputSchema.safeParse({ ...base, ttl: 30 }).success).toBe(
    true,
  );
  expect(dnsRecordInputSchema.safeParse({ ...base, ttl: 29 }).success).toBe(
    false,
  );
  expect(
    dnsRecordInputSchema.safeParse({
      ...base,
      ttl: 1,
      comment: "x".repeat(500),
    }).success,
  ).toBe(true);
  expect(
    dnsRecordInputSchema.safeParse({
      ...base,
      ttl: 1,
      comment: "x".repeat(501),
    }).success,
  ).toBe(false);
});

test("a write is named in Activity before rigd reads its record", () => {
  expect(
    requestedDnsChange("dns-create", {
      record: { type: "A", name: "a.example.com" },
    }),
  ).toBe("create A a.example.com");
  expect(requestedDnsChange("dns-delete", { id: "abc" })).toBe(
    "delete record abc",
  );
});

test("proxy.dns.address refuses addresses no other machine reaches this Mac at", () => {
  const host = (address: string) => () =>
    parseHostConfig({
      proxy: { caddy: "/usr/local/bin/caddy", dns: { address } },
    });
  for (const address of [
    "0.0.0.0",
    "127.0.0.1",
    "127.8.9.1",
    "169.254.1.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
  ])
    expect(host(address)).toThrow();
  expect(host("100.64.0.7")().proxy?.dns?.address).toBe("100.64.0.7");
  expect(host("192.168.1.20")().proxy?.dns?.address).toBe("192.168.1.20");
});

test("proxy.dns is left out of the settings Caddy serves: its digest and pending fields ignore it", async () => {
  const caddy = { caddy: "/usr/local/bin/caddy" };
  const without = parseHostConfig({ proxy: caddy }).proxy!;
  const withDns = parseHostConfig({
    proxy: { ...caddy, dns: { address: "100.64.0.7", zones: ["example.com"] } },
  }).proxy!;
  expect(settingsDigest(withDns)).toBe(settingsDigest(without));
  expect(
    await pendingSettings("/nonexistent-rig-root", withDns, without),
  ).toBeUndefined();
  const moved = parseHostConfig({
    proxy: {
      ...caddy,
      ports: { http: 8080, https: 8443 },
      dns: { address: "100.64.0.7" },
    },
  }).proxy!;
  expect(
    (await pendingSettings("/nonexistent-rig-root", moved, without))?.fields,
  ).toEqual(["ports"]);
});

test("equivalent contents compare equal as Cloudflare normalizes them: IPv6 canonical, CAA by flags, tag and value", () => {
  expect(canonicalIpv6("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe(
    "2001:db8::1",
  );
  expect(canonicalIpv6("2001:db8:0:0:1:0:0:1")).toBe("2001:db8::1:0:0:1");
  expect(canonicalIpv6("::ffff:192.0.2.1")).toBe("::ffff:c000:201");
  expect(canonicalIpv6("fd7a:115c:a1e0::1")).toBe("fd7a:115c:a1e0::1");
  expect(canonicalIpv6("1:2:3:4:5:6:7:8")).toBe("1:2:3:4:5:6:7:8");
  expect(canonicalIpv6("not-an-address")).toBeUndefined();
  // The WHATWG URL parser writes RFC 5952 text too: an independent check.
  for (const address of [
    "2001:0db8:0000:0000:0000:ff00:0042:8329",
    "0:0:0:0:0:0:0:1",
    "fe80:0:0:1:0:0:0:0",
  ])
    expect(canonicalIpv6(address)).toBe(
      new URL(`http://[${address}]/`).hostname.slice(1, -1),
    );
  expect(sameContent("AAAA", "2001:0db8::0001", "2001:db8::1")).toBe(true);
  expect(sameContent("AAAA", "2001:db8::1", "2001:db8::2")).toBe(false);
  expect(
    sameContent(
      "CAA",
      '0  issue   "letsencrypt.org"',
      '0 issue "letsencrypt.org"',
    ),
  ).toBe(true);
  expect(
    sameContent("CAA", '0 ISSUE "letsencrypt.org"', "0 issue letsencrypt.org"),
  ).toBe(true);
  expect(
    sameContent(
      "CAA",
      '0 issue "letsencrypt.org"',
      '128 issue "letsencrypt.org"',
    ),
  ).toBe(false);
  expect(
    sameContent(
      "CAA",
      '0 issue "letsencrypt.org"',
      '0 issuewild "letsencrypt.org"',
    ),
  ).toBe(false);
  expect(contentKey("A", "100.064.000.007")).toBe("100.64.0.7");
});

test("a CAA value keeps its exact characters: only the separators between fields are normalized", () => {
  expect(
    sameContent(
      "CAA",
      '0  issue  "letsencrypt.org"',
      '0 issue "letsencrypt.org"',
    ),
  ).toBe(true);
  expect(
    sameContent(
      "CAA",
      '0 issue "letsencrypt.org "',
      '0 issue "letsencrypt.org "',
    ),
  ).toBe(false);
  expect(sameContent("CAA", '0 issue "a  b"', '0 issue "a b"')).toBe(false);
});

test("a null MX (RFC 7505) keeps its root exchange, needs preference 0, and only MX has one", () => {
  const nullMx = {
    name: "example.com",
    type: "MX",
    content: ".",
    priority: 0,
    ttl: 600,
  };
  const parsed = dnsRecordInputSchema.parse(nullMx);
  expect(normalizeRecordInput(parsed).content).toBe(".");
  expect(sameContent("MX", ".", ".")).toBe(true);
  expect(contentKey("MX", " . ")).toBe(".");
  expect(sameContent("MX", ".", "mail.example.com")).toBe(false);

  const refused = (fields: Record<string, unknown>) =>
    dnsRecordInputSchema.safeParse({ ...nullMx, ...fields }).error?.issues[0];
  expect(refused({ priority: 10 })).toMatchObject({
    path: ["priority"],
    message: "must be 0 for a null MX (.)",
  });
  expect(refused({ priority: undefined })?.path).toEqual(["priority"]);
  expect(refused({ type: "CNAME", priority: undefined })?.path).toEqual([
    "content",
  ]);
  expect(refused({ content: ".." })?.path).toEqual(["content"]);

  // An ordinary exchange is still canonical, whatever its priority.
  const ordinary = dnsRecordInputSchema.parse({
    ...nullMx,
    content: "Mail.Example.com.",
    priority: 0,
  });
  expect(normalizeRecordInput(ordinary).content).toBe("mail.example.com");
});

const txtRefused = (content: string) =>
  dnsRecordInputSchema.safeParse({
    name: "a.example.com",
    type: "TXT",
    content,
    ttl: 1,
  }).error?.issues[0]?.message;
const quoted = (...strings: string[]) =>
  strings.map((string) => `"${string}"`).join(" ");

test("a TXT record's limit is its 4096 bytes in DNS, not how many characters it takes to write", () => {
  // Bare text: Cloudflare splits it every 255 bytes, each string with a length byte. 4080 bytes make 16 strings, 4096 in all.
  expect(txtRefused("x".repeat(4080))).toBeUndefined();
  expect(txtRefused("x".repeat(4081))).toContain("4096 bytes");
  expect(txtRefused("v=spf1 include:_spf.example.com -all")).toBeUndefined();

  // Split strings: 16 of 255 bytes are exactly the limit, and a byte more is over, however they are divided.
  const full = Array.from({ length: 16 }, () => "x".repeat(255));
  expect(txtRefused(quoted(...full))).toBeUndefined();
  expect(txtRefused(quoted(...full, "x"))).toContain("4096 bytes");

  // Bytes, not characters: "é" is two bytes.
  expect(txtRefused("é".repeat(2040))).toBeUndefined();
  expect(txtRefused("é".repeat(2041))).toContain("4096 bytes");

  // \DDD and \" are one byte each however long they are to write, so 16,367 characters can be within the limit.
  const escaped = Array.from({ length: 16 }, () => "\\065".repeat(255));
  expect(quoted(...escaped).length).toBeGreaterThan(16_000);
  expect(txtRefused(quoted(...escaped))).toBeUndefined();
  expect(txtRefused(quoted(...escaped, "\\065"))).toContain("4096 bytes");
  const quotes = Array.from({ length: 16 }, () => '\\"'.repeat(255));
  expect(txtRefused(quoted(...quotes))).toBeUndefined();
});

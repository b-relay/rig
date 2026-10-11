import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { DnsRecord, HostnameCheck } from "@/lib/types";
import { DnsZoneRecords } from "./dns-records";
import { DnsHostnames } from "./dns-hostnames";

/** The DNS section's components rendered as the server sends them, inside a router that goes nowhere. No rigd and no
 * Cloudflare: the records and checks are written here. */
const router = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
} as never;
const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      {node}
    </AppRouterContext.Provider>,
  );
const MAC = "100.64.0.7";
const zone = { id: "z1", name: "example.com", status: "active" };
const record = (
  fields: Partial<DnsRecord> & Pick<DnsRecord, "name" | "type" | "content">,
): DnsRecord => ({
  id: `id-${fields.name}-${fields.type}`,
  zone: "example.com",
  ttl: 1,
  modifiedOn: "2026-10-01T00:00:00Z",
  ...fields,
});

test("a zone's records show relative names, types, content, proxying and TTL; only managed types can be edited", () => {
  const html = render(
    <DnsZoneRecords
      zone={zone}
      records={[
        record({
          name: "example.com",
          type: "MX",
          content: "mail.example.com",
          priority: 10,
          ttl: 3600,
        }),
        record({
          name: "app.example.com",
          type: "A",
          content: MAC,
          proxied: false,
        }),
        record({
          name: "cdn.example.com",
          type: "CNAME",
          content: "edge.example.net",
          proxied: true,
          comment: "CDN",
        }),
        record({
          name: "_sip._tcp.example.com",
          type: "SRV",
          content: "1 1 5060 sip.example.com",
        }),
      ]}
    />,
  );
  expect(html).toContain("4 records");
  expect(html).toContain("Add record");
  expect(html).toContain(">@<");
  expect(html).toContain(">app<");
  expect(html).toContain(">10 mail.example.com<");
  expect(html).toContain("TTL 1 h");
  expect(html).toContain("DNS only");
  expect(html).toContain("proxied");
  expect(html).toContain("CDN");
  expect(html).toContain('aria-label="Edit A app.example.com"');
  expect(html).toContain('aria-label="Delete CNAME cdn.example.com"');
  // An SRV record is listed but not changed from here.
  expect(html).not.toContain('aria-label="Edit SRV');
  expect(html).toContain("Rig lists SRV records but does not change them");
});

test("the hostname check says where each name points, says when only a wildcard covers it, and offers Point at this Mac", () => {
  const checks: HostnameCheck[] = [
    {
      hostname: "app.example.com",
      sources: [{ kind: "target", project: "pantry", target: "stable" }],
      zone: "example.com",
      verdict: "mac",
      wildcard: true,
      answeredBy: "*.example.com",
      chain: [],
      addresses: [{ type: "A", content: MAC }],
      reason:
        "Covered only by the wildcard *.example.com, which points at this Mac.",
    },
    {
      hostname: "grafana.example.com",
      sources: [{ kind: "route" }],
      zone: "example.com",
      verdict: "elsewhere",
      wildcard: false,
      answeredBy: "grafana.example.com",
      chain: [],
      addresses: [{ type: "A", content: "203.0.113.5" }],
      reason: `It points at 203.0.113.5, not this Mac (${MAC}).`,
      fix: {
        op: "update",
        zone: "example.com",
        id: "a1",
        modifiedOn: "m",
        from: "203.0.113.5",
        record: {
          name: "grafana.example.com",
          type: "A",
          content: MAC,
          ttl: 1,
          proxied: false,
        },
      },
    },
    {
      hostname: "www.example.com",
      sources: [{ kind: "target", project: "pantry", target: "stable" }],
      zone: "example.com",
      verdict: "elsewhere",
      wildcard: false,
      chain: ["www.example.com -> shop.example.net"],
      addresses: [],
      reason:
        "It is a CNAME to shop.example.net, outside the zones Rig manages.",
      fixBlocked:
        "www.example.com is a CNAME to shop.example.net; edit or delete that record to point the name at this Mac.",
    },
  ];
  const html = render(
    <DnsHostnames checks={checks} address={MAC} addressSource="tailscale" />,
  );
  expect(html).toContain("2 of 3 hostnames do not point at this Mac.");
  expect(html).toContain(
    "A name covered only by a wildcard counts when the wildcard points here.",
  );
  expect(html).toContain(`>${MAC}</span> (Tailscale)`);
  expect(html).toContain("this Mac");
  expect(html).toContain("via the wildcard");
  expect(html).toContain("pantry / stable");
  expect(html).toContain("your route (proxy.routes)");
  expect(html).toContain(
    `Changes its A record from 203.0.113.5 to ${MAC}, DNS only.`,
  );
  expect(html.match(/Point at this Mac/g)).toHaveLength(1);
  expect(html).toContain("edit or delete that record");
});

test("without this Mac's address the check says how to set it", () => {
  const html = render(<DnsHostnames checks={[]} />);
  expect(html).toContain("Rig serves no hostname yet.");
  expect(html).toContain(
    "unknown: set proxy.dns.address, or install Tailscale",
  );
});

test("Point at this Mac adds a record in one click, but asks before it changes one that exists", () => {
  const base = {
    sources: [{ kind: "route" as const }],
    zone: "example.com",
    verdict: "elsewhere" as const,
    wildcard: false,
    chain: [],
    addresses: [],
    reason: "x",
  };
  const record = {
    name: "a.example.com",
    type: "A" as const,
    content: MAC,
    ttl: 1,
    proxied: false,
  };
  const html = render(
    <DnsHostnames
      address={MAC}
      checks={[
        {
          ...base,
          hostname: "a.example.com",
          fix: { op: "create", zone: "example.com", record },
        },
        {
          ...base,
          hostname: "b.example.com",
          fix: {
            op: "update",
            zone: "example.com",
            id: "b1",
            modifiedOn: "m",
            from: "203.0.113.5",
            record: { ...record, name: "b.example.com" },
          },
        },
      ]}
    />,
  );
  const buttons = [...html.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
  expect(buttons).toHaveLength(2);
  expect(buttons[0]).not.toContain('aria-haspopup="dialog"');
  expect(buttons[1]).toContain('aria-haspopup="dialog"');
});

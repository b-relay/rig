import { afterEach, expect, test } from "bun:test";
import { chmod, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createDnsControl } from "../src/adapters/dns-control";
import { readDnsToken } from "../src/adapters/dns-token";
import type { DnsReport } from "../src/runtime/contracts";
import { createRuntime } from "../src/runtime/application";
import { writeProxyToken } from "../src/adapters/proxy-token";
import { parseHostConfig } from "../src/config";
import type { ProxySettings } from "../src/config/proxy-schema";
import { RigError } from "../src/domain/errors";
import { proxyPaths } from "../src/domain/managed-proxy";
import { commandSchema, readActions } from "../src/daemon/protocol";
import { createCloudflareDns } from "../src/providers/cloudflare-dns";
import { runtimeWorld } from "./support/runtime-world";
import { fakeCloudflare } from "./support/fake-cloudflare";

/** Synthetic: the shape of a Cloudflare token, never a real one. The Rig root is a temporary directory and Cloudflare a
 * fake on 127.0.0.1, so nothing here reads the real token or reaches the real API. */
const TOKEN = "synthetic-test-token-0123456789-ABCDEFGHIJ";
const MAC = "100.64.0.7";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

function settings(proxy: Record<string, unknown> = {}): ProxySettings {
  return parseHostConfig({ proxy: { caddy: "/usr/local/bin/caddy", ...proxy } })
    .proxy!;
}
/** The real runtime over a temporary Rig root, with rigd's DNS control reading the stored token and a fake Cloudflare. */
async function world(
  options: {
    proxy?: Record<string, unknown> | null;
    tailscale?: string;
    timeoutMs?: number;
  } = {},
) {
  const fake = fakeCloudflare({
    token: TOKEN,
    zones: [
      { id: "z1", name: "example.com" },
      { id: "z2", name: "example.org" },
    ],
    records: {
      z1: [
        {
          id: "a1",
          name: "app.example.com",
          type: "A",
          content: "203.0.113.5",
          ttl: 300,
          proxied: false,
        },
        {
          id: "w1",
          name: "*.example.com",
          type: "A",
          content: MAC,
          ttl: 1,
          proxied: false,
        },
        {
          id: "t1",
          name: "example.com",
          type: "TXT",
          content: "v=spf1 -all",
          ttl: 1,
        },
      ],
      z2: [],
    },
  });
  cleanup.push(() => fake.stop());
  const providers: string[] = [];
  const host =
    options.proxy === null
      ? undefined
      : settings(options.proxy ?? { dns: { address: MAC } });
  const built = await runtimeWorld({
    name: "dns",
    config: { name: "demo", services: {} } as never,
    supervisor: () => ({}) as never,
    startsAt: "2026-10-11T00:00:00.000Z",
    readinessDeadlineMs: 1000,
    dependencies: ({ root }) => ({
      dns: createDnsControl({
        settings: async () => host,
        token: () => readDnsToken(root),
        provider: (name, token) => {
          providers.push(name);
          return createCloudflareDns({
            token,
            baseUrl: fake.url,
            timeoutMs: options.timeoutMs ?? 2000,
          });
        },
        address: { ipv4: async () => options.tailscale },
      }),
    }),
  });
  cleanup.push(() => rm(built.root, { recursive: true, force: true }));
  await writeProxyToken(built.root, `${TOKEN}\n`);
  return { ...built, fake, providers, runtime: built.open() };
}
async function refusal(promise: Promise<unknown>): Promise<RigError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(RigError);
  return caught as RigError;
}
/** Every file under the Rig root except the token itself, as one string: the token must be in none of them. */
async function everythingButTheToken(root: string): Promise<string> {
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  const texts = await Promise.all(
    files
      .filter(
        (entry) =>
          entry.isFile() &&
          join(entry.parentPath, entry.name) !== proxyPaths(root).token,
      )
      .map((entry) =>
        readFile(join(entry.parentPath, entry.name), "utf8").catch(() => ""),
      ),
  );
  return texts.join("\n");
}

test("dns is a read and dns-create, dns-update and dns-delete are mutations on the control plane", () => {
  expect(readActions.has("dns")).toBe(true);
  for (const action of ["dns-create", "dns-update", "dns-delete"] as const) {
    expect(readActions.has(action)).toBe(false);
    expect(
      commandSchema.safeParse({
        action,
        dns: { zone: "example.com", id: "a1", modifiedOn: "x" },
      }).success,
    ).toBe(true);
  }
  // A record id that could reach a URL path other than its own is refused at the boundary.
  expect(
    commandSchema.safeParse({
      action: "dns-delete",
      dns: { zone: "example.com", id: "../a1" },
    }).success,
  ).toBe(false);
});

test("the read lists every zone's records and checks the served hostnames, the owner's routes among them, with the wildcard", async () => {
  const { runtime } = await world({
    proxy: {
      routes: { "grafana.example.com": 3000, "app.example.com": 3001 },
      dns: { address: MAC },
    },
  });
  const report = (await runtime.command({ action: "dns" })) as DnsReport;
  expect(report).toMatchObject({
    provider: "cloudflare",
    address: MAC,
    addressSource: "config",
  });
  expect(report.zones.map((zone) => zone.name)).toEqual([
    "example.com",
    "example.org",
  ]);
  expect(
    report.records.map((record) => `${record.type} ${record.name}`),
  ).toEqual(["A *.example.com", "A app.example.com", "TXT example.com"]);
  expect(
    report.hostnames.map((check) => [
      check.hostname,
      check.verdict,
      check.wildcard,
    ]),
  ).toEqual([
    ["app.example.com", "elsewhere", false],
    ["grafana.example.com", "mac", true],
  ]);
  expect(report.hostnames[1]!.sources).toEqual([{ kind: "route" }]);
  // One zone narrows the read.
  const one = (await runtime.command({
    action: "dns",
    dns: { zone: "example.org" },
  })) as DnsReport;
  expect(one.records).toEqual([]);
  expect(
    (
      await refusal(
        runtime.command({ action: "dns", dns: { zone: "nope.test" } }),
      )
    ).code,
  ).toBe("DNS_ZONE");
});

test("proxy.dns.zones narrows the zones, and a zone it names that the token cannot see is reported", async () => {
  const { runtime } = await world({
    proxy: { dns: { zones: ["example.org", "missing.test"] } },
    tailscale: "100.100.1.1",
  });
  const report = (await runtime.command({ action: "dns" })) as DnsReport;
  expect(report.zones.map((zone) => zone.name)).toEqual(["example.org"]);
  expect(report.unseenZones).toEqual(["missing.test"]);
  expect(report).toMatchObject({
    address: "100.100.1.1",
    addressSource: "tailscale",
  });
  // A write to a zone outside the list is refused before anything is sent.
  const writes = await refusal(
    runtime.command({
      action: "dns-create",
      dns: {
        zone: "example.com",
        record: { name: "x.example.com", type: "A", content: MAC, ttl: 1 },
      },
    }),
  );
  expect(writes.code).toBe("DNS_ZONE");
});

test("an update or delete of a record changed or deleted since it was read is refused as DNS_CHANGED, and nothing is written", async () => {
  const { runtime, fake } = await world();
  const read = (await runtime.command({ action: "dns" })) as DnsReport;
  const app = read.records.find((record) => record.name === "app.example.com")!;
  fake.touch("z1", "a1", { content: "198.51.100.1" });
  const record = {
    name: "app.example.com",
    type: "A",
    content: MAC,
    ttl: 300,
    proxied: false,
  };
  const stale = await refusal(
    runtime.command({
      action: "dns-update",
      dns: {
        zone: "example.com",
        id: app.id,
        modifiedOn: app.modifiedOn,
        record,
      },
    }),
  );
  expect(stale.code).toBe("DNS_CHANGED");
  expect(stale.message).toBe(
    "A app.example.com changed since you read it, so Rig did not write.",
  );
  expect(fake.requests.some((request) => request.method === "PATCH")).toBe(
    false,
  );

  const deleted = read.records.find((record) => record.type === "TXT")!;
  fake.records.get("z1")!.splice(
    fake.records.get("z1")!.findIndex((each) => each.id === "t1"),
    1,
  );
  const gone = await refusal(
    runtime.command({
      action: "dns-delete",
      dns: {
        zone: "example.com",
        id: deleted.id,
        modifiedOn: deleted.modifiedOn,
        confirm: deleted.name,
      },
    }),
  );
  expect(gone.code).toBe("DNS_CHANGED");
  expect(fake.requests.some((request) => request.method === "DELETE")).toBe(
    false,
  );

  // A create that expected the name to be free refuses once a record of its type is there.
  const taken = await refusal(
    runtime.command({
      action: "dns-create",
      dns: {
        zone: "example.com",
        absent: true,
        record: { name: "app.example.com", type: "A", content: MAC, ttl: 1 },
      },
    }),
  );
  expect(taken.code).toBe("DNS_CHANGED");
  expect(taken.message).toContain("app.example.com gained A 198.51.100.1");
  expect(fake.requests.some((request) => request.method === "POST")).toBe(
    false,
  );
});

test("a write read fresh goes through, and Activity records the record's name and type, never the token", async () => {
  const { runtime, fake, root } = await world();
  const read = (await runtime.command({ action: "dns" })) as DnsReport;
  const app = read.records.find((record) => record.name === "app.example.com")!;
  const fix = read.hostnames.find(
    (check) => check.hostname === "app.example.com",
  );
  expect(fix).toBeUndefined(); // no Target or route serves it in this world
  const updated = (await runtime.command({
    action: "dns-update",
    operationId: "op-update",
    dns: {
      zone: "example.com",
      id: app.id,
      modifiedOn: app.modifiedOn,
      record: {
        name: "app.example.com",
        type: "A",
        content: MAC,
        ttl: 300,
        proxied: false,
      },
    },
  })) as Record<string, unknown>;
  expect(updated).toMatchObject({
    outcome: "updated",
    zone: "example.com",
    summary: `updated A app.example.com -> ${MAC} (was 203.0.113.5)`,
    record: { content: MAC },
  });
  const created = (await runtime.command({
    action: "dns-create",
    operationId: "op-create",
    dns: {
      zone: "example.com",
      absent: true,
      record: {
        name: "_dmarc.example.com",
        type: "TXT",
        content: "v=DMARC1; p=none",
        ttl: 1,
      },
    },
  })) as Record<string, unknown>;
  expect(created.summary).toBe("created TXT _dmarc.example.com");
  const txt = fake.records
    .get("z1")!
    .find((each) => each.name === "_dmarc.example.com")!;
  await runtime.command({
    action: "dns-delete",
    operationId: "op-delete",
    dns: {
      zone: "example.com",
      id: txt.id,
      modifiedOn: txt.modified_on,
      confirm: txt.name,
    },
  });
  // A provider refusal while writing is a failed Operation that still names the record.
  fake.answerNext(
    400,
    {
      success: false,
      errors: [{ code: 9005, message: `Content invalid; token ${TOKEN}` }],
      result: null,
    },
    undefined,
    "POST",
  );
  const failed = await refusal(
    runtime.command({
      action: "dns-create",
      operationId: "op-fail",
      dns: {
        zone: "example.com",
        record: { name: "b.example.com", type: "A", content: MAC, ttl: 1 },
      },
    }),
  );
  expect(failed.code).toBe("DNS_PROVIDER");
  expect(failed.message).not.toContain(TOKEN);

  const activity = (await runtime.command({ action: "activity" })) as {
    operations: {
      id: string;
      action: string;
      outcome: string;
      message?: string;
    }[];
  };
  expect(
    activity.operations.map(({ id, action, outcome, message }) => ({
      id,
      action,
      outcome,
      message,
    })),
  ).toEqual([
    {
      id: "op-update",
      action: "dns-update",
      outcome: "updated",
      message: `update A app.example.com -> ${MAC} (was 203.0.113.5)`,
    },
    {
      id: "op-create",
      action: "dns-create",
      outcome: "updated",
      message: "create TXT _dmarc.example.com",
    },
    {
      id: "op-delete",
      action: "dns-delete",
      outcome: "updated",
      message: "delete TXT _dmarc.example.com",
    },
    {
      id: "op-fail",
      action: "dns-create",
      outcome: "failed",
      message: `create A b.example.com -> ${MAC}: DNS_PROVIDER`,
    },
  ]);
  expect(await everythingButTheToken(root)).not.toContain(TOKEN);
});

test("a record that breaks its type's rules is DNS_RECORD naming the field, before anything is sent", async () => {
  const { runtime, fake } = await world();
  const cases: [Record<string, unknown>, string][] = [
    [
      { name: "a.example.com", type: "A", content: "300.1.1.1", ttl: 1 },
      "content",
    ],
    [
      { name: "a.example.com", type: "AAAA", content: "1.2.3.4", ttl: 1 },
      "content",
    ],
    [
      { name: "a.example.com", type: "CNAME", content: "not a host", ttl: 1 },
      "content",
    ],
    [
      { name: "a.example.com", type: "TXT", content: "x".repeat(2049), ttl: 1 },
      "content",
    ],
    [
      {
        name: "a.example.com",
        type: "MX",
        content: "mail.example.com",
        ttl: 1,
      },
      "priority",
    ],
    [
      {
        name: "a.example.com",
        type: "CAA",
        content: "0 issue letsencrypt.org",
        ttl: 1,
      },
      "content",
    ],
    [
      {
        name: "a.example.com",
        type: "TXT",
        content: "x",
        ttl: 1,
        proxied: true,
      },
      "proxied",
    ],
    [{ name: "a.example.com", type: "A", content: "1.2.3.4", ttl: 29 }, "ttl"],
    [{ name: "a.example.org", type: "A", content: "1.2.3.4", ttl: 1 }, "name"],
    [
      { name: "Bad_Name!.example.com", type: "A", content: "1.2.3.4", ttl: 1 },
      "name",
    ],
    [{ name: "a.example.com", type: "SRV", content: "x", ttl: 1 }, "type"],
  ];
  for (const [record, field] of cases) {
    const refused = await refusal(
      runtime.command({
        action: "dns-create",
        dns: { zone: "example.com", record: record as never },
      }),
    );
    expect(refused.code).toBe("DNS_RECORD");
    expect(refused.details.field).toBe(field);
  }
  expect(fake.requests.some((request) => request.method === "POST")).toBe(
    false,
  );
});

test("without a proxy section or a usable token the DNS commands say what is missing and how to set it up", async () => {
  const bare = await world({ proxy: null });
  const unconfigured = await refusal(bare.runtime.command({ action: "dns" }));
  expect(unconfigured.code).toBe("DNS_UNCONFIGURED");
  expect(unconfigured.hint).toContain("rig proxy token");

  const { runtime, root } = await world();
  await chmod(proxyPaths(root).token, 0o644);
  const exposed = await refusal(runtime.command({ action: "dns" }));
  expect(exposed.code).toBe("DNS_TOKEN");
  expect(exposed.message).toContain("readable by others (mode 644)");
  await rm(proxyPaths(root).token);
  const missing = await refusal(runtime.command({ action: "dns" }));
  expect(missing).toMatchObject({ code: "DNS_TOKEN" });
  expect(missing.hint).toContain("pbpaste | rig proxy token");
  for (const failure of [exposed, missing])
    expect(
      JSON.stringify({ ...failure, message: failure.message }),
    ).not.toContain(TOKEN);
});

type Activity = {
  operations: {
    id: string;
    action: string;
    outcome: string;
    message?: string;
  }[];
};
const activity = async (runtime: {
  command(command: never): Promise<unknown>;
}) =>
  (
    (await runtime.command({ action: "activity" } as never)) as Activity
  ).operations.map(({ id, action, outcome, message }) => ({
    id,
    action,
    outcome,
    message,
  }));

test("one zone the token cannot read leaves the others shown, and its hostnames unknown rather than missing", async () => {
  const { runtime, fake, providers } = await world({
    proxy: {
      routes: { "app.example.com": 3000, "shop.example.org": 3001 },
      dns: { address: MAC },
    },
  });
  fake.breakZone("z2", 403, 10000, "Authentication error");
  const report = (await runtime.command({ action: "dns" })) as DnsReport;
  expect(providers).toEqual(["cloudflare"]);
  expect(report.zones.map((zone) => zone.name)).toEqual(["example.com"]);
  expect(report.unreadableZones).toEqual([
    {
      zone: "example.org",
      code: "DNS_AUTH",
      message: expect.stringContaining("Authentication error"),
    },
  ]);
  expect(report.records.length).toBe(3);
  const shop = report.hostnames.find(
    (check) => check.hostname === "shop.example.org",
  )!;
  expect(shop).toMatchObject({ verdict: "unknown", zone: "example.org" });
  expect(shop.reason).toContain("could not read the records of example.org");
  expect(shop.fix).toBeUndefined();
  // With no zone readable, the read fails with the reason, so the page shows the setup steps.
  fake.breakZone("z1", 403, 10000, "Authentication error");
  expect((await refusal(runtime.command({ action: "dns" }))).code).toBe(
    "DNS_AUTH",
  );
});

test("a write whose answer is lost after Cloudflare made it is reported as made, after reading it back", async () => {
  const { runtime, fake } = await world({ timeoutMs: 300 });
  fake.answerLate("POST", 800);
  const created = (await runtime.command({
    action: "dns-create",
    operationId: "op-late-create",
    dns: {
      zone: "example.com",
      absent: true,
      record: { name: "new.example.com", type: "A", content: MAC, ttl: 1 },
    },
  })) as Record<string, unknown>;
  expect(created).toMatchObject({
    outcome: "updated",
    record: { name: "new.example.com", content: MAC },
  });

  const read = (await runtime.command({ action: "dns" })) as DnsReport;
  const app = read.records.find((record) => record.name === "app.example.com")!;
  fake.answerLate("PATCH", 800);
  const updated = (await runtime.command({
    action: "dns-update",
    operationId: "op-late-update",
    dns: {
      zone: "example.com",
      id: app.id,
      modifiedOn: app.modifiedOn,
      record: {
        name: "app.example.com",
        type: "A",
        content: MAC,
        ttl: 300,
        proxied: false,
      },
    },
  })) as Record<string, unknown>;
  expect(updated).toMatchObject({
    outcome: "updated",
    record: { content: MAC },
  });

  const txt = read.records.find((record) => record.type === "TXT")!;
  fake.answerLate("DELETE", 800);
  await runtime.command({
    action: "dns-delete",
    operationId: "op-late-delete",
    dns: {
      zone: "example.com",
      id: txt.id,
      modifiedOn: txt.modifiedOn,
      confirm: txt.name,
    },
  });
  expect(fake.records.get("z1")!.some((record) => record.id === txt.id)).toBe(
    false,
  );
  expect(
    (await activity(runtime)).map((each) => [each.id, each.outcome]),
  ).toEqual([
    ["op-late-create", "updated"],
    ["op-late-update", "updated"],
    ["op-late-delete", "updated"],
  ]);

  // A lost answer to a write Cloudflare did not make stays a failure.
  fake.answerNext(200, { success: true, result: null }, 800, "POST");
  const failed = await refusal(
    runtime.command({
      action: "dns-create",
      operationId: "op-lost",
      dns: {
        zone: "example.com",
        record: { name: "other.example.com", type: "A", content: MAC, ttl: 1 },
      },
    }),
  );
  expect(failed.code).toBe("DNS_TIMEOUT");
});

test("a delete or update that races the record's removal is DNS_CHANGED, not a provider failure", async () => {
  const { runtime, fake } = await world();
  const read = (await runtime.command({ action: "dns" })) as DnsReport;
  const txt = read.records.find((record) => record.type === "TXT")!;
  // Removed between rigd's check and its write: Cloudflare answers the DELETE with 404.
  fake.answerNext(
    404,
    {
      success: false,
      errors: [{ code: 81044, message: "Record does not exist." }],
      result: null,
    },
    undefined,
    "DELETE",
  );
  const raced = await refusal(
    runtime.command({
      action: "dns-delete",
      dns: {
        zone: "example.com",
        id: txt.id,
        modifiedOn: txt.modifiedOn,
        confirm: txt.name,
      },
    }),
  );
  expect(raced.code).toBe("DNS_CHANGED");
  const app = read.records.find((record) => record.name === "app.example.com")!;
  fake.answerNext(
    404,
    {
      success: false,
      errors: [{ code: 81044, message: "Record does not exist." }],
      result: null,
    },
    undefined,
    "PATCH",
  );
  const patched = await refusal(
    runtime.command({
      action: "dns-update",
      dns: {
        zone: "example.com",
        id: app.id,
        modifiedOn: app.modifiedOn,
        record: { name: "app.example.com", type: "A", content: MAC, ttl: 300 },
      },
    }),
  );
  expect(patched.code).toBe("DNS_CHANGED");
});

test("provider failures before the write are failed Operations; stale or malformed requests are refusals, not Activity", async () => {
  const { runtime, fake } = await world();
  fake.answerNext(
    429,
    {
      success: false,
      errors: [{ code: 971, message: "Please wait" }],
      result: null,
    },
    undefined,
    "GET",
  );
  const limited = await refusal(
    runtime.command({
      action: "dns-create",
      operationId: "op-limited",
      dns: {
        zone: "example.com",
        record: { name: "x.example.com", type: "A", content: MAC, ttl: 1 },
      },
    }),
  );
  expect(limited.code).toBe("DNS_RATE_LIMIT");
  const read = (await runtime.command({ action: "dns" })) as DnsReport;
  const app = read.records.find((record) => record.name === "app.example.com")!;
  fake.touch("z1", "a1", { ttl: 600 });
  await refusal(
    runtime.command({
      action: "dns-delete",
      operationId: "op-stale",
      dns: { zone: "example.com", id: app.id, modifiedOn: app.modifiedOn },
    }),
  );
  await refusal(
    runtime.command({
      action: "dns-create",
      operationId: "op-invalid",
      dns: {
        zone: "example.com",
        record: { name: "x.example.com", type: "A", content: "nope", ttl: 1 },
      },
    }),
  );
  expect(await activity(runtime)).toEqual([
    {
      id: "op-limited",
      action: "dns-create",
      outcome: "failed",
      message: "create A x.example.com: DNS_RATE_LIMIT",
    },
  ]);
});

test("renaming a record in an edit says so in Activity; a TTL of 30 and a long comment Cloudflare stored can be edited", async () => {
  const { runtime, fake } = await world();
  fake.touch("z1", "a1", { ttl: 30, comment: "x".repeat(300) });
  const read = (await runtime.command({ action: "dns" })) as DnsReport;
  const app = read.records.find((record) => record.id === "a1")!;
  expect(app).toMatchObject({ ttl: 30 });
  const reply = (await runtime.command({
    action: "dns-update",
    operationId: "op-rename",
    dns: {
      zone: "example.com",
      id: app.id,
      modifiedOn: app.modifiedOn,
      record: {
        name: "web.example.com",
        type: "A",
        content: "203.0.113.5",
        ttl: 30,
        comment: app.comment!,
      },
    },
  })) as Record<string, unknown>;
  expect(reply.summary).toBe(
    "updated A web.example.com -> 203.0.113.5 (renamed from app.example.com)",
  );
  expect((await activity(runtime))[0]!.message).toBe(
    "update A web.example.com -> 203.0.113.5 (renamed from app.example.com)",
  );
});

test("a rigd composed without DNS says DNS_UNAVAILABLE, apart from a Host that has no proxy section", async () => {
  const { deps } = await world();
  const bare = createRuntime({ ...deps, dns: undefined });
  expect((await refusal(bare.command({ action: "dns" }))).code).toBe(
    "DNS_UNAVAILABLE",
  );
});

test("a delete needs the record's name typed, checked by rigd against the record it reads just before deleting", async () => {
  const { runtime, fake } = await world();
  const read = (await runtime.command({ action: "dns" })) as DnsReport;
  const txt = read.records.find((record) => record.type === "TXT")!;
  const asked = (confirm?: string) =>
    runtime.command({
      action: "dns-delete",
      operationId: `op-${confirm ?? "none"}`,
      dns: {
        zone: "example.com",
        id: txt.id,
        modifiedOn: txt.modifiedOn,
        ...(confirm !== undefined ? { confirm } : {}),
      },
    });
  const missing = await refusal(asked());
  expect(missing).toMatchObject({ code: "DNS_CONFIRMATION" });
  expect(missing.message).toBe(
    "Deleting TXT example.com needs its name typed to confirm.",
  );
  const wrong = await refusal(asked("app.example.com"));
  expect(wrong.message).toBe(
    "What was typed does not name TXT example.com, so Rig did not delete it.",
  );
  expect(fake.requests.some((request) => request.method === "DELETE")).toBe(
    false,
  );
  expect(await activity(runtime)).toEqual([]);
  // Typed in any case, with a trailing dot, it names the record.
  await asked(" Example.COM. ");
  expect(fake.records.get("z1")!.some((record) => record.id === txt.id)).toBe(
    false,
  );
});

test("a lost write whose read-back differs in any field asked for stays a failure: an MX priority that did not change", async () => {
  const { runtime, fake } = await world({ timeoutMs: 300 });
  const mx = (await runtime.command({
    action: "dns-create",
    dns: {
      zone: "example.com",
      record: {
        name: "example.com",
        type: "MX",
        content: "mail.example.com",
        ttl: 1,
        priority: 10,
      },
    },
  })) as { record: { id: string; modifiedOn: string } };
  // The PATCH is answered late and never made: Cloudflare still says priority 10.
  fake.answerNext(200, { success: true, result: null }, 800, "PATCH");
  const lost = await refusal(
    runtime.command({
      action: "dns-update",
      dns: {
        zone: "example.com",
        id: mx.record.id,
        modifiedOn: mx.record.modifiedOn,
        record: {
          name: "example.com",
          type: "MX",
          content: "mail.example.com",
          ttl: 1,
          priority: 20,
        },
      },
    }),
  );
  expect(lost.code).toBe("DNS_TIMEOUT");
  // The same goes for a comment the change carried.
  const now = (await runtime.command({ action: "dns" })) as DnsReport;
  const app = now.records.find((record) => record.name === "app.example.com")!;
  fake.answerNext(200, { success: true, result: null }, 800, "PATCH");
  const comment = await refusal(
    runtime.command({
      action: "dns-update",
      dns: {
        zone: "example.com",
        id: app.id,
        modifiedOn: app.modifiedOn,
        record: {
          name: "app.example.com",
          type: "A",
          content: app.content,
          ttl: app.ttl,
          proxied: false,
          comment: "new note",
        },
      },
    }),
  );
  expect(comment.code).toBe("DNS_TIMEOUT");
});

test("a create whose answer is cut off mid-body is read back and reported as made", async () => {
  const { runtime, fake } = await world();
  fake.cutOffNext("POST");
  const created = (await runtime.command({
    action: "dns-create",
    operationId: "op-cut",
    dns: {
      zone: "example.com",
      absent: true,
      record: { name: "cut.example.com", type: "A", content: MAC, ttl: 1 },
    },
  })) as Record<string, unknown>;
  expect(created).toMatchObject({
    outcome: "updated",
    record: { name: "cut.example.com" },
  });
  expect(
    fake.records
      .get("z1")!
      .filter((record) => record.name === "cut.example.com"),
  ).toHaveLength(1);
});

test("a lost write whose read-back holds an equivalent content Cloudflare normalized is reported as made", async () => {
  const { runtime, fake } = await world({ timeoutMs: 300 });
  fake.answerLate("POST", 800);
  const aaaa = (await runtime.command({
    action: "dns-create",
    dns: {
      zone: "example.com",
      record: {
        name: "v6.example.com",
        type: "AAAA",
        content: "2001:0db8:0000:0000:0000:0000:0000:0001",
        ttl: 1,
      },
    },
  })) as { outcome: string; record: { content: string } };
  expect(aaaa).toMatchObject({
    outcome: "updated",
    record: { content: "2001:db8::1" },
  });
  fake.answerLate("POST", 800);
  const caa = (await runtime.command({
    action: "dns-create",
    dns: {
      zone: "example.com",
      record: {
        name: "example.com",
        type: "CAA",
        content: '0  issue   "letsencrypt.org"',
        ttl: 1,
      },
    },
  })) as { outcome: string; record: { content: string } };
  expect(caa).toMatchObject({
    outcome: "updated",
    record: { content: '0 issue "letsencrypt.org"' },
  });
});

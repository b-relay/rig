import { afterEach, expect, test } from "bun:test";
import { chmod, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createDnsControl } from "../src/adapters/dns-control";
import { readDnsToken } from "../src/adapters/dns-token";
import type { DnsRecord } from "../src/domain/dns-records";
import type { DnsProvider } from "../src/providers/contracts";
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
import { fakeCloudflare, type FakeRecord } from "./support/fake-cloudflare";

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
    /** What example.org holds, by default nothing. */
    org?: Omit<FakeRecord, "modified_on">[];
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
      z2: options.org ?? [],
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
      { name: "a.example.com", type: "TXT", content: "x".repeat(4081), ttl: 1 },
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

/** DNS control over an in-memory provider that records which zones' records were asked for, in order. */
function zonesWorld(options: {
  zones: string[];
  records?: Record<string, [name: string, type: string, content: string][]>;
  failing?: string[];
  delayMs?: Record<string, number>;
  routes?: Record<string, number>;
}) {
  const zones = options.zones.map((name, index) => ({
    id: `z${index}`,
    name,
    status: "active",
  }));
  const asked: string[] = [];
  const provider = {
    zones: async () => zones,
    async records(zone) {
      asked.push(zone.name);
      await Bun.sleep(options.delayMs?.[zone.name] ?? 0);
      if (options.failing?.includes(zone.name))
        throw new RigError(
          "DNS_AUTH",
          `Cannot read ${zone.name}.`,
          "Check the token.",
        );
      return (options.records?.[zone.name] ?? []).map(
        ([name, type, content], index): DnsRecord => ({
          id: `${zone.id}r${index}`,
          zone: zone.name,
          name,
          type,
          content,
          ttl: 1,
          proxied: false,
          modifiedOn: "m",
        }),
      );
    },
  } as DnsProvider;
  const control = createDnsControl({
    settings: async () =>
      settings({ routes: options.routes ?? {}, dns: { address: MAC } }),
    token: async () => TOKEN,
    provider: () => provider,
    address: { ipv4: async () => undefined },
  });
  return { control, asked };
}
const TWELVE = Array.from({ length: 12 }, (_, index) => `zone${index}.test`);

test("a read of one zone asks for that zone's records alone, and shows only what that zone owns", async () => {
  const { control, asked } = zonesWorld({
    zones: TWELVE,
    records: {
      "zone0.test": [["app.zone0.test", "A", MAC]],
      "zone1.test": [["app.zone1.test", "A", MAC]],
    },
    failing: ["zone11.test"],
    delayMs: { "zone11.test": 5000 },
    routes: { "app.zone0.test": 3000, "app.zone1.test": 3001 },
  });
  const started = Date.now();
  const report = await control.read({ zone: "zone0.test", hostnames: [] });
  // A slow, unreadable, unrelated zone was never asked, so it cannot delay this or fail it.
  expect(Date.now() - started).toBeLessThan(2000);
  expect(asked).toEqual(["zone0.test"]);
  expect(report.zones.map((zone) => zone.name)).toEqual(["zone0.test"]);
  expect(report.records.map((record) => record.zone)).toEqual(["zone0.test"]);
  expect(report.hostnames.map((check) => check.hostname)).toEqual([
    "app.zone0.test",
  ]);
  expect(report.hostnames[0]!.verdict).toBe("mac");
  expect(report.unreadableZones).toBeUndefined();
});

test("a read of one zone reads another only when a CNAME of its hostnames leads there, and shows only its own records", async () => {
  const { control, asked } = zonesWorld({
    zones: ["a.test", "b.test", "c.test", "unrelated.test"],
    records: {
      "a.test": [["app.a.test", "CNAME", "hop.b.test"]],
      "b.test": [["hop.b.test", "CNAME", "end.c.test"]],
      "c.test": [["end.c.test", "A", MAC]],
      "unrelated.test": [["end.unrelated.test", "A", MAC]],
    },
    routes: { "app.a.test": 3000 },
  });
  const report = await control.read({ zone: "a.test", hostnames: [] });
  expect(asked).toEqual(["a.test", "b.test", "c.test"]);
  expect(report.hostnames[0]).toMatchObject({
    hostname: "app.a.test",
    verdict: "mac",
    chain: ["app.a.test -> hop.b.test", "hop.b.test -> end.c.test"],
  });
  expect(report.zones.map((zone) => zone.name)).toEqual(["a.test"]);
  expect(report.records.map((record) => record.name)).toEqual(["app.a.test"]);
  expect(report.unreadableZones).toBeUndefined();
});

test("a CNAME into a zone that cannot be read leaves the selected read a success: that hostname is unknown, and the zone named", async () => {
  const { control, asked } = zonesWorld({
    zones: ["a.test", "bad.test"],
    records: {
      "a.test": [
        ["app.a.test", "CNAME", "end.bad.test"],
        ["own.a.test", "A", MAC],
      ],
    },
    failing: ["bad.test"],
    routes: { "app.a.test": 3000, "own.a.test": 3001 },
  });
  const report = await control.read({ zone: "a.test", hostnames: [] });
  expect(asked).toEqual(["a.test", "bad.test"]);
  expect(report.records).toHaveLength(2);
  expect(report.hostnames).toMatchObject([
    { hostname: "app.a.test", verdict: "unknown" },
    { hostname: "own.a.test", verdict: "mac" },
  ]);
  expect(report.hostnames[0]!.reason).toContain(
    "whose records Rig could not read just now",
  );
  expect(report.unreadableZones).toEqual([
    { zone: "bad.test", code: "DNS_AUTH", message: "Cannot read bad.test." },
  ]);
});

test("a parent zone's read leaves a child zone unread and unlisted, and a CNAME into it is answered by the child", async () => {
  const world = () =>
    zonesWorld({
      zones: ["example.test", "sub.example.test"],
      records: {
        "example.test": [
          ["app.sub.example.test", "A", "203.0.113.8"],
          ["*.sub.example.test", "A", "203.0.113.8"],
          ["alias.example.test", "CNAME", "end.sub.example.test"],
        ],
        "sub.example.test": [
          ["app.sub.example.test", "A", MAC],
          ["end.sub.example.test", "A", MAC],
        ],
      },
      routes: { "app.sub.example.test": 3000 },
    });
  const parent = world();
  const report = await parent.control.read({
    zone: "example.test",
    hostnames: [],
  });
  expect(parent.asked).toEqual(["example.test"]);
  expect(report.zones.map((zone) => zone.name)).toEqual(["example.test"]);
  // The hostname belongs to the child, however its name reads, so it is the child's read that shows it.
  expect(report.hostnames).toEqual([]);
  expect(report.records).toHaveLength(3);

  const child = world();
  const below = await child.control.read({
    zone: "sub.example.test",
    hostnames: [],
  });
  expect(child.asked).toEqual(["sub.example.test"]);
  expect(below.hostnames).toMatchObject([
    {
      hostname: "app.sub.example.test",
      zone: "sub.example.test",
      verdict: "mac",
    },
  ]);

  const cname = world();
  const alias = await cname.control.read({
    zone: "example.test",
    hostnames: [
      {
        hostname: "alias.example.test",
        sources: [{ kind: "route" }],
      },
    ],
  });
  expect(cname.asked).toEqual(["example.test", "sub.example.test"]);
  expect(alias.hostnames).toMatchObject([
    { hostname: "alias.example.test", verdict: "mac" },
  ]);
  expect(alias.records.map((record) => record.zone)).toEqual([
    "example.test",
    "example.test",
    "example.test",
  ]);
});

test("a selected zone that cannot be read fails the read with its own error, whether or not another zone is readable", async () => {
  for (const zones of [["bad.test"], ["bad.test", "ok.test"]]) {
    const { control, asked } = zonesWorld({ zones, failing: ["bad.test"] });
    const failed = await refusal(
      control.read({ zone: "bad.test", hostnames: [] }),
    );
    expect(failed).toMatchObject({
      code: "DNS_AUTH",
      message: "Cannot read bad.test.",
    });
    expect(asked).toEqual(["bad.test"]);
  }
  // A zone that is readable and empty is a success, and one Rig does not manage is refused before anything is read.
  const { control, asked } = zonesWorld({
    zones: ["bad.test", "empty.test"],
    failing: ["bad.test"],
  });
  expect(
    await control.read({ zone: "empty.test", hostnames: [] }),
  ).toMatchObject({
    zones: [{ name: "empty.test" }],
    records: [],
    hostnames: [],
  });
  asked.length = 0;
  expect(
    (await refusal(control.read({ zone: "other.test", hostnames: [] }))).code,
  ).toBe("DNS_ZONE");
  expect(asked).toEqual([]);
});

test("an account-wide read reads every zone, four at a time, without waiting for a slow one to start the next", async () => {
  const zones = ["slow.test", "b.test", "c.test", "d.test", "e.test"];
  const { control, asked } = zonesWorld({
    zones,
    records: { "e.test": [["app.e.test", "A", MAC]] },
    failing: ["c.test"],
    delayMs: { "slow.test": 150 },
    routes: { "app.e.test": 3000, "app.c.test": 3001 },
  });
  const pending = control.read({ hostnames: [] });
  await Bun.sleep(50);
  // Four at a time, and the fifth began when one of the quick ones finished, with the slow one still running.
  expect(asked).toEqual(zones);
  const report = await pending;
  expect(report.zones.map((zone) => zone.name)).toEqual([
    "slow.test",
    "b.test",
    "d.test",
    "e.test",
  ]);
  expect(report.records).toHaveLength(1);
  expect(report.unreadableZones).toMatchObject([{ zone: "c.test" }]);
  expect(report.hostnames).toMatchObject([
    { hostname: "app.c.test", verdict: "unknown" },
    { hostname: "app.e.test", verdict: "mac" },
  ]);
});

test("a null MX can be created and its TTL changed through rigd, and no other MX can stand beside it", async () => {
  const { runtime, fake } = await world({
    org: [
      {
        id: "mx1",
        name: "mail.example.org",
        type: "MX",
        content: ".",
        ttl: 300,
        priority: 0,
      },
      {
        id: "mx2",
        name: "ordinary.example.org",
        type: "MX",
        content: "mail.example.net",
        ttl: 300,
        priority: 10,
      },
    ],
  });
  const read = async () =>
    ((await runtime.command({ action: "dns" })) as DnsReport).records;
  const nullMx = (await read()).find((record) => record.id === "mx1")!;
  expect(nullMx).toMatchObject({ content: ".", priority: 0 });

  const edited = (await runtime.command({
    action: "dns-update",
    dns: {
      zone: "example.org",
      id: "mx1",
      modifiedOn: nullMx.modifiedOn,
      record: {
        name: "mail.example.org",
        type: "MX",
        content: ".",
        priority: 0,
        ttl: 600,
      },
    },
  })) as { record: { content: string; ttl: number } };
  expect(edited.record).toMatchObject({ content: ".", ttl: 600 });
  expect(fake.requests.at(-1)).toMatchObject({
    method: "PATCH",
    body: { content: ".", priority: 0, ttl: 600 },
  });

  const created = (await runtime.command({
    action: "dns-create",
    dns: {
      zone: "example.org",
      absent: true,
      record: {
        name: "none.example.org",
        type: "MX",
        content: ".",
        priority: 0,
        ttl: 1,
      },
    },
  })) as { record: { content: string } };
  expect(created.record.content).toBe(".");

  const writes = () =>
    fake.requests.filter((request) => request.method !== "GET").length;
  const before = writes();
  const mx = (name: string, content: string, priority: number) => ({
    name,
    type: "MX",
    content,
    priority,
    ttl: 1,
  });
  // A second MX beside a null MX, a null MX beside an MX, and a priority a null MX cannot have, each before any write.
  for (const [record, says] of [
    [
      mx("mail.example.org", "backup.example.net", 20),
      "has a null MX, which says it takes no mail",
    ],
    [
      mx("ordinary.example.org", ".", 0),
      "A null MX says a name takes no mail, but ordinary.example.org has MX mail.example.net",
    ],
    [mx("new.example.org", ".", 10), "must be 0 for a null MX (.)"],
  ] as const) {
    const failed = await refusal(
      runtime.command({
        action: "dns-create",
        dns: { zone: "example.org", record },
      }),
    );
    expect(failed.code).toBe("DNS_RECORD");
    expect(failed.message).toContain(says);
  }
  // An update that would turn one of two MX records into a null MX is refused; the only one may become it.
  const second = (await runtime.command({
    action: "dns-create",
    dns: {
      zone: "example.org",
      record: mx("ordinary.example.org", "backup.example.net", 20),
    },
  })) as { record: { id: string; modifiedOn: string } };
  const failed = await refusal(
    runtime.command({
      action: "dns-update",
      dns: {
        zone: "example.org",
        id: second.record.id,
        modifiedOn: second.record.modifiedOn,
        record: mx("ordinary.example.org", ".", 0),
      },
    }),
  );
  expect(failed.code).toBe("DNS_RECORD");
  expect(writes()).toBe(before + 1);
  const only = (await read()).find((record) => record.id === "mx2")!;
  await runtime.command({
    action: "dns-delete",
    dns: {
      zone: "example.org",
      id: second.record.id,
      modifiedOn: second.record.modifiedOn,
      confirm: "ordinary.example.org",
    },
  });
  expect(
    await runtime.command({
      action: "dns-update",
      dns: {
        zone: "example.org",
        id: "mx2",
        modifiedOn: only.modifiedOn,
        record: mx("ordinary.example.org", ".", 0),
      },
    }),
  ).toMatchObject({ outcome: "updated", record: { content: "." } });
});

test("a TTL or comment edit of an MX beside a null MX Cloudflare already holds goes through: it adds no clash of its own", async () => {
  const { runtime } = await world({
    org: [
      {
        id: "mx1",
        name: "both.example.org",
        type: "MX",
        content: ".",
        ttl: 300,
        priority: 0,
      },
      {
        id: "mx2",
        name: "both.example.org",
        type: "MX",
        content: "mail.example.net",
        ttl: 300,
        priority: 10,
      },
    ],
  });
  const { records } = (await runtime.command({ action: "dns" })) as DnsReport;
  for (const stored of records.filter(
    (record) => record.zone === "example.org",
  ))
    expect(
      await runtime.command({
        action: "dns-update",
        dns: {
          zone: "example.org",
          id: stored.id,
          modifiedOn: stored.modifiedOn,
          record: {
            name: stored.name,
            type: "MX",
            content: stored.content,
            priority: stored.priority,
            ttl: 600,
          },
        },
      }),
    ).toMatchObject({ outcome: "updated" });
});

test("a long TXT record Cloudflare stored is read, and its TTL and comment edited, with its content as stored", async () => {
  const content = [
    ...Array.from({ length: 8 }, () => `"${"x".repeat(255)}"`),
    '"xxxxxxxx"',
  ].join(" ");
  const { runtime, fake } = await world({
    org: [
      {
        id: "t1",
        name: "dkim.example.org",
        type: "TXT",
        content,
        ttl: 300,
      },
    ],
  });
  const { records } = (await runtime.command({ action: "dns" })) as DnsReport;
  const stored = records.find((record) => record.id === "t1")!;
  expect(stored.content).toBe(content);
  const command = {
    action: "dns-update" as const,
    dns: {
      zone: "example.org",
      id: "t1",
      modifiedOn: stored.modifiedOn,
      record: {
        name: stored.name,
        type: "TXT",
        content,
        ttl: 600,
        comment: "dkim",
      },
    },
  };
  expect(commandSchema.safeParse(command).success).toBe(true);
  expect(await runtime.command(command)).toMatchObject({
    outcome: "updated",
    record: { content, ttl: 600 },
  });
  expect(fake.requests.at(-1)).toMatchObject({
    method: "PATCH",
    body: { content, ttl: 600, comment: "dkim" },
  });
  // The control plane carries the longest content the schema accepts: every byte of 4096 written as \DDD.
  const longest = Array.from(
    { length: 16 },
    () => `"${"\\065".repeat(255)}"`,
  ).join(" ");
  expect(
    commandSchema.safeParse({
      ...command,
      dns: {
        ...command.dns,
        record: { ...command.dns.record, content: longest },
      },
    }).success,
  ).toBe(true);
  const failed = await refusal(
    runtime.command({
      action: "dns-create",
      dns: {
        zone: "example.org",
        record: { ...command.dns.record, content: "x".repeat(4081) },
      },
    }),
  );
  expect(failed.code).toBe("DNS_RECORD");
  expect(failed.message).toContain("4096 bytes");
});

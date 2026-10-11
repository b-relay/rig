import { afterEach, expect, test } from "bun:test";
import { createCloudflareDns } from "../src/providers/cloudflare-dns";
import { RigError } from "../src/domain/errors";
import { fakeCloudflare } from "./support/fake-cloudflare";

/** Synthetic: the shape of a Cloudflare token, never a real one. Every request goes to a fake server on 127.0.0.1. */
const TOKEN = "synthetic-test-token-0123456789-ABCDEFGHIJ";
const zone = { id: "z1", name: "example.com", status: "active" };
const servers: { stop(): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});
function world(options: Partial<Parameters<typeof fakeCloudflare>[0]> = {}) {
  const fake = fakeCloudflare({ token: TOKEN, zones: [zone], ...options });
  servers.push(fake);
  const provider = createCloudflareDns({
    token: TOKEN,
    baseUrl: fake.url,
    timeoutMs: 2000,
  });
  return { fake, provider };
}
/** Everything a failure carries to a user or a log, as one string. */
function everything(error: unknown): string {
  const failure = error as RigError;
  return JSON.stringify({
    message: failure.message,
    hint: failure.hint,
    details: failure.details,
    code: failure.code,
    stack: failure.stack,
  });
}
async function failure(promise: Promise<unknown>): Promise<RigError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(RigError);
  return caught as RigError;
}

test("zones and records are read page by page until the last page, by result_info or by a short page", async () => {
  const many = Array.from({ length: 7 }, (_, index) => ({
    id: `r${index}`,
    name: `host${index}.example.com`,
    type: "A",
    content: `100.64.0.${index}`,
    ttl: 1,
  }));
  const paged = world({
    zones: [
      zone,
      { id: "z2", name: "example.org" },
      { id: "z3", name: "example.net" },
    ],
    records: { z1: many, z2: [], z3: [] },
    pageCap: 3,
  });
  expect((await paged.provider.zones()).map((each) => each.name)).toEqual([
    "example.com",
    "example.org",
    "example.net",
  ]);
  const records = await paged.provider.records(zone);
  expect(records.map((record) => record.name)).toEqual(
    many.map((record) => record.name),
  );
  expect(records[0]).toMatchObject({
    zone: "example.com",
    type: "A",
    content: "100.64.0.0",
    ttl: 1,
  });
  const pages = paged.fake.requests.filter((request) =>
    request.path.endsWith("/dns_records"),
  );
  expect(
    pages.map((request) => new URLSearchParams(request.query).get("page")),
  ).toEqual(["1", "2", "3"]);
  // Every request carried the token as a Bearer header and nowhere else.
  for (const request of paged.fake.requests) {
    expect(request.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request.query).not.toContain(TOKEN);
  }

  // Without result_info, a page shorter than asked for is the last.
  const bare = world({ records: { z1: many }, omitResultInfo: true });
  expect(await bare.provider.records(zone)).toHaveLength(7);
});

test("a listing longer than the page limit is refused rather than read without end", async () => {
  const fake = fakeCloudflare({
    token: TOKEN,
    zones: [zone],
    records: {
      z1: Array.from({ length: 5 }, (_, index) => ({
        id: `r${index}`,
        name: `h${index}.example.com`,
        type: "A",
        content: "1.1.1.1",
        ttl: 1,
      })),
    },
    pageCap: 1,
  });
  servers.push(fake);
  const provider = createCloudflareDns({
    token: TOKEN,
    baseUrl: fake.url,
    maxPages: 2,
  });
  expect((await failure(provider.records(zone))).code).toBe("DNS_PROVIDER");
});

test("a refused token is DNS_AUTH, and the token never appears in any failure even when Cloudflare quotes it", async () => {
  const { fake } = world();
  const wrong = createCloudflareDns({ token: `${TOKEN}x`, baseUrl: fake.url });
  const refused = await failure(wrong.zones());
  expect(refused.code).toBe("DNS_AUTH");
  expect(refused.message).toContain("Invalid access token");
  expect(refused.message).toContain("[redacted]");
  expect(everything(refused)).not.toContain(TOKEN);

  // Cloudflare quoting the token in any refusal, anywhere in its text, is redacted too.
  const { fake: other, provider } = world();
  other.answerNext(400, {
    success: false,
    errors: [
      {
        code: 1004,
        message: `DNS Validation Error: bad token ${TOKEN} in request`,
      },
    ],
    result: null,
  });
  const quoted = await failure(provider.zones());
  expect(quoted.code).toBe("DNS_PROVIDER");
  expect(quoted.message).toContain("DNS Validation Error");
  expect(everything(quoted)).not.toContain(TOKEN);
});

test("errors are tagged by what went wrong: refusal, rate limit, malformed answer, timeout, unreachable", async () => {
  const { fake, provider } = world();
  fake.answerNext(400, {
    success: false,
    errors: [{ code: 9005, message: "Content for A record is invalid." }],
    result: null,
  });
  const invalid = await failure(
    provider.create(zone, {
      name: "a.example.com",
      type: "A",
      content: "1.2.3.4",
      ttl: 1,
    }),
  );
  expect(invalid).toMatchObject({ code: "DNS_PROVIDER" });
  expect(invalid.message).toContain("Content for A record is invalid. (9005)");

  fake.answerNext(429, {
    success: false,
    errors: [{ code: 971, message: "Please wait" }],
    result: null,
  });
  expect((await failure(provider.zones())).code).toBe("DNS_RATE_LIMIT");

  fake.answerNext(200, "<html>not json</html>");
  expect((await failure(provider.zones())).code).toBe("DNS_PROVIDER_RESPONSE");

  fake.answerNext(200, {
    success: true,
    errors: [],
    result: [{ id: "../../etc", name: "x.com" }],
  });
  expect((await failure(provider.zones())).message).toContain(
    "form Rig does not understand",
  );

  fake.answerNext(200, { success: true, result: [] }, 500);
  const slow = createCloudflareDns({
    token: TOKEN,
    baseUrl: fake.url,
    timeoutMs: 50,
  });
  const timedOut = await failure(slow.zones());
  expect(timedOut.code).toBe("DNS_TIMEOUT");
  expect(everything(timedOut)).not.toContain(TOKEN);

  const closed = createCloudflareDns({
    token: TOKEN,
    baseUrl: "http://127.0.0.1:9/client/v4",
    timeoutMs: 1000,
  });
  const unreachable = await failure(closed.zones());
  expect(["DNS_UNREACHABLE", "DNS_TIMEOUT"]).toContain(unreachable.code);
  expect(everything(unreachable)).not.toContain(TOKEN);
});

test("a fetch that throws with the token in its message never passes the token on", async () => {
  const provider = createCloudflareDns({
    token: TOKEN,
    fetch: async (_url, init) => {
      throw new Error(`connect failed with ${JSON.stringify(init.headers)}`);
    },
  });
  const caught = await failure(provider.zones());
  expect(caught.code).toBe("DNS_UNREACHABLE");
  expect(everything(caught)).not.toContain(TOKEN);
});

test("create, update and delete send Cloudflare's shapes: CAA as data, proxied only where it applies, MX priority", async () => {
  const { fake, provider } = world();
  const a = await provider.create(zone, {
    name: "app.example.com",
    type: "A",
    content: "100.64.0.1",
    ttl: 1,
    proxied: false,
  });
  expect(a).toMatchObject({
    name: "app.example.com",
    type: "A",
    content: "100.64.0.1",
    proxied: false,
  });
  await provider.create(zone, {
    name: "example.com",
    type: "CAA",
    content: '0 issue "letsencrypt.org"',
    ttl: 3600,
  });
  await provider.create(zone, {
    name: "example.com",
    type: "MX",
    content: "mail.example.com",
    ttl: 1,
    priority: 10,
  });
  await provider.create(zone, {
    name: "_dmarc.example.com",
    type: "TXT",
    content: "v=DMARC1; p=none",
    ttl: 1,
    comment: "mail",
  });
  const bodies = fake.requests
    .filter((request) => request.method === "POST")
    .map((request) => request.body);
  expect(bodies).toEqual([
    {
      name: "app.example.com",
      type: "A",
      ttl: 1,
      content: "100.64.0.1",
      proxied: false,
    },
    {
      name: "example.com",
      type: "CAA",
      ttl: 3600,
      data: { flags: 0, tag: "issue", value: "letsencrypt.org" },
    },
    {
      name: "example.com",
      type: "MX",
      ttl: 1,
      content: "mail.example.com",
      priority: 10,
    },
    {
      name: "_dmarc.example.com",
      type: "TXT",
      ttl: 1,
      content: "v=DMARC1; p=none",
      comment: "mail",
    },
  ]);
  const updated = await provider.update(zone, a.id, {
    name: "app.example.com",
    type: "A",
    content: "100.64.0.2",
    ttl: 300,
    proxied: false,
  });
  expect(updated).toMatchObject({ content: "100.64.0.2", ttl: 300 });
  expect(updated!.modifiedOn).not.toBe(a.modifiedOn);
  expect(fake.requests.at(-1)).toMatchObject({
    method: "PATCH",
    path: `/client/v4/zones/z1/dns_records/${a.id}`,
  });
  expect(await provider.record(zone, a.id)).toMatchObject({
    content: "100.64.0.2",
  });
  await provider.delete(zone, a.id);
  expect(await provider.record(zone, a.id)).toBeUndefined();
  // An id that is not one never reaches a URL.
  expect((await failure(provider.delete(zone, "../zones"))).code).toBe(
    "DNS_REQUEST",
  );
});

test("a redirect is never followed and is reported as one; writes to a record that is gone say so instead of failing", async () => {
  const { fake, provider } = world();
  fake.answerNext(302, "", undefined, "GET");
  const redirected = await failure(provider.zones());
  expect(redirected.code).toBe("DNS_PROVIDER_RESPONSE");
  expect(redirected.message).toContain("redirect (HTTP 302)");
  expect(fake.requests).toHaveLength(1);

  const record = {
    name: "gone.example.com",
    type: "A" as const,
    content: "100.64.0.1",
    ttl: 1,
  };
  expect(await provider.update(zone, "deadbeef", record)).toBeUndefined();
  expect(await provider.delete(zone, "deadbeef")).toBe(false);
});

test("CNAME and MX targets are read lowercase, without a trailing dot", async () => {
  const { provider } = world({
    records: {
      z1: [
        {
          id: "c1",
          name: "WWW.Example.com",
          type: "CNAME",
          content: "App.Example.COM.",
          ttl: 1,
        },
        {
          id: "m1",
          name: "example.com",
          type: "MX",
          content: "Mail.Example.com",
          ttl: 1,
          priority: 10,
        },
        {
          id: "t1",
          name: "example.com",
          type: "TXT",
          content: "Keep Case",
          ttl: 1,
        },
      ],
    },
  });
  expect(
    (await provider.records(zone)).map((record) => [
      record.name,
      record.content,
    ]),
  ).toEqual([
    ["www.example.com", "app.example.com"],
    ["example.com", "mail.example.com"],
    ["example.com", "Keep Case"],
  ]);
});

test("an answer cut off mid-body is a lost reply (DNS_UNREACHABLE), while a whole body that is not JSON is malformed", async () => {
  const { fake, provider } = world();
  fake.cutOffNext("POST");
  const cut = await failure(
    provider.create(zone, {
      name: "a.example.com",
      type: "A",
      content: "100.64.0.1",
      ttl: 1,
    }),
  );
  expect(cut.code).toBe("DNS_UNREACHABLE");
  expect(cut.message).toContain("was cut off");
  expect(fake.records.get("z1")).toHaveLength(1);
  fake.answerNext(200, "not json at all");
  expect((await failure(provider.zones())).code).toBe("DNS_PROVIDER_RESPONSE");
});

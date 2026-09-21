import { test, expect } from "bun:test";
import {
  accessPolicy,
  admit,
  parseTrustedClients,
  trustedClient,
} from "../web/server/guard";
import { createRelay } from "../web/server/relay";

const policy = accessPolicy({
  publicHost: "rig.b-relay.com",
  port: 4100,
  trustedClients: parseTrustedClients("100.64.0.0/10, FD7A::1"),
});
const request = (method: string, headers: Record<string, string>) => ({
  method,
  headers: new Headers(headers),
});
const post = (headers: Record<string, string>) =>
  request("POST", {
    host: "rig.b-relay.com",
    origin: "https://rig.b-relay.com",
    "content-type": "application/json",
    ...headers,
  });

test("the site's own page is admitted under its published name and on loopback", () => {
  expect(admit(post({ "x-forwarded-for": "127.0.0.1" }), policy)).toEqual({
    admitted: true,
  });
  expect(
    admit(
      post({ host: "127.0.0.1:4100", origin: "http://127.0.0.1:4100" }),
      policy,
    ),
  ).toEqual({ admitted: true });
  expect(
    admit(request("GET", { host: "localhost:4100" }), policy).admitted,
  ).toBe(true);
});

test("a foreign host name, origin, or fetch site is refused", () => {
  expect(admit(post({ host: "evil.test" }), policy)).toMatchObject({
    status: 403,
    code: "HOST",
  });
  expect(admit(request("GET", {}), policy)).toMatchObject({ code: "HOST" });
  expect(admit(post({ origin: "https://evil.test" }), policy)).toMatchObject({
    status: 403,
    code: "ORIGIN",
  });
  expect(admit(post({ "sec-fetch-site": "cross-site" }), policy)).toMatchObject(
    { code: "ORIGIN" },
  );
  // The published name is https only; its plain-http origin is someone else's page.
  expect(
    admit(post({ origin: "http://rig.b-relay.com" }), policy),
  ).toMatchObject({ code: "ORIGIN" });
});

test("a change needs a JSON body and a browser origin", () => {
  expect(admit(post({ "content-type": "text/plain" }), policy)).toMatchObject({
    status: 415,
    code: "CONTENT_TYPE",
  });
  expect(
    admit(post({ "content-type": "application/json; charset=utf-8" }), policy)
      .admitted,
  ).toBe(true);
  expect(
    admit(
      request("POST", {
        host: "rig.b-relay.com",
        "content-type": "application/json",
      }),
      policy,
    ),
  ).toMatchObject({ code: "ORIGIN" });
});

test("only loopback and trusted client addresses pass, and every forwarded hop must", () => {
  expect(
    admit(post({ "x-forwarded-for": "203.0.113.9" }), policy),
  ).toMatchObject({ status: 403, code: "CLIENT" });
  expect(
    admit(post({ "x-forwarded-for": "100.101.102.103" }), policy).admitted,
  ).toBe(true);
  expect(
    admit(post({ "x-forwarded-for": "127.0.0.1, 203.0.113.9" }), policy),
  ).toMatchObject({ code: "CLIENT" });
  expect(trustedClient("::1", [])).toBe(true);
  expect(trustedClient("::ffff:127.0.0.1", [])).toBe(true);
  expect(trustedClient("FD7A::1", parseTrustedClients("fd7a::1"))).toBe(true);
  expect(
    trustedClient("100.128.0.1", parseTrustedClients("100.64.0.0/10")),
  ).toBe(false);
  expect(trustedClient("10.0.0.1", parseTrustedClients("0.0.0.0/0"))).toBe(
    true,
  );
  expect(trustedClient("not-an-ip", parseTrustedClients("10.0.0.0/8"))).toBe(
    false,
  );
});

test("the relay forwards to the discovered rigd with the credential and answers rigd's own status and body", async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const relay = createRelay({
    address: async () => ({ port: 5123, token: "host-secret" }),
    send: async (url, init) => {
      sent.push({ url, init });
      return Response.json(
        { error: { code: "TARGETS_RUNNING", message: "Running." } },
        { status: 422 },
      );
    },
  });
  const answer = await relay("/api/command", '{"action":"forget"}');
  expect(sent[0]!.url).toBe("http://127.0.0.1:5123/v1/command");
  expect(sent[0]!.init.method).toBe("POST");
  expect(sent[0]!.init.body).toBe('{"action":"forget"}');
  expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe(
    "Bearer host-secret",
  );
  expect(answer.status).toBe(422);
  const text = await answer.text();
  expect(JSON.parse(text).error.code).toBe("TARGETS_RUNNING");
  expect(text).not.toContain("host-secret");
  await relay("/api/health", undefined);
  expect(sent[1]!.url).toBe("http://127.0.0.1:5123/health");
  expect(sent[1]!.init.method).toBe("GET");
  expect(sent[1]!.init.body).toBeUndefined();
  const abandoned = new AbortController();
  await relay("/api/health", undefined, abandoned.signal);
  expect(sent[2]!.init.signal).toBe(abandoned.signal);
});

test("a missing or unreachable rigd is a 503 with the reason rig would give", async () => {
  const missing = createRelay({
    address: async () => {
      throw Object.assign(new Error("rigd is not installed or reachable."), {
        code: "DAEMON_MISSING",
        hint: "Run rigd install to start the daemon.",
      });
    },
    send: async () => {
      throw new Error("not reached");
    },
  });
  const first = await missing("/api/health", undefined);
  expect(first.status).toBe(503);
  expect(await first.json()).toEqual({
    error: {
      code: "DAEMON_MISSING",
      message: "rigd is not installed or reachable.",
      hint: "Run rigd install to start the daemon.",
    },
  });
  const refused = createRelay({
    address: async () => ({ port: 1, token: "t" }),
    send: async () => {
      throw new TypeError("connection refused");
    },
  });
  const second = await refused("/api/command", "{}");
  expect(second.status).toBe(503);
  expect((await second.json()).error.code).toBe("DAEMON_UNREACHABLE");
});

test("a malformed trusted-client entry stops the server instead of widening access", () => {
  for (const entry of [
    "10.0.0.0/",
    "10.0.0.0/33",
    "10.0.0.0/24/8",
    "office",
    "10.0.0",
  ])
    expect(() => parseTrustedClients(entry)).toThrow(TypeError);
  expect(parseTrustedClients("")).toEqual([]);
  expect(trustedClient("10.1.2.3", parseTrustedClients("10.1.2.3"))).toBe(true);
  expect(trustedClient("10.1.2.4", parseTrustedClients("10.1.2.3"))).toBe(
    false,
  );
});

test("a request that came through a tunnel is refused even from loopback", () => {
  expect(
    admit(
      post({
        "x-forwarded-for": "127.0.0.1",
        "cf-connecting-ip": "203.0.113.9",
      }),
      policy,
    ),
  ).toMatchObject({ status: 403, code: "CLIENT" });
});

test("a Preview of the site never relays and names the host that does", () => {
  const preview = accessPolicy({
    publicHost: "feature-x.rig.b-relay.com",
    dashboardHost: "rig.b-relay.com",
    port: 4100,
  });
  expect(
    admit(
      post({
        host: "feature-x.rig.b-relay.com",
        origin: "https://feature-x.rig.b-relay.com",
      }),
      preview,
    ),
  ).toMatchObject({ status: 403, code: "PREVIEW" });
  expect(
    accessPolicy({
      publicHost: "rig.b-relay.com",
      dashboardHost: "rig.b-relay.com",
      port: 4100,
    }).relaysAt,
  ).toBeUndefined();
  expect(
    accessPolicy({ dashboardHost: "rig.b-relay.com", port: 4100 }).relaysAt,
  ).toBeUndefined();
});

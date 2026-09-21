import { test, expect } from "bun:test";
import {
  accessPolicy,
  admit,
  keyMatches,
  sessionCookie,
  sessionValue,
  signedIn,
  parseTrustedClients,
  trustedClient,
} from "../web/server/guard";
import { createRelay } from "../web/server/relay";
import { sandboxDaemon } from "../web/server/sandbox";
import { downCommands, seedSandbox, seedSteps } from "../web/server/seed";

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

test("a sandboxed Preview relays, since it only reaches its own rigd", () => {
  const sandboxed = accessPolicy({
    publicHost: "feature.rig.b-relay.com",
    dashboardHost: "rig.b-relay.com",
    port: 4100,
    sandboxed: true,
  });
  expect(sandboxed.relaysAt).toBeUndefined();
  expect(
    admit(
      post({
        host: "feature.rig.b-relay.com",
        origin: "https://feature.rig.b-relay.com",
        "x-forwarded-for": "127.0.0.1",
      }),
      sandboxed,
    ),
  ).toEqual({ admitted: true });
  // Sandboxing lifts only the Preview rule; strangers are still refused.
  expect(
    admit(
      post({
        host: "feature.rig.b-relay.com",
        origin: "https://feature.rig.b-relay.com",
        "x-forwarded-for": "203.0.113.9",
      }),
      sandboxed,
    ),
  ).toMatchObject({ code: "CLIENT" });
});

test("the sandbox daemon installs into its own root and reports a refused stop", async () => {
  const calls: string[] = [];
  const sandbox = sandboxDaemon("/tmp/box", async (command) => {
    calls.push(command);
    return { exitCode: command === "install" ? 0 : 1, output: "" };
  });
  await sandbox.start();
  expect(await sandbox.stop()).toBe(false);
  expect(calls).toEqual(["install", "uninstall"]);
  const broken = sandboxDaemon("/tmp/box", async () => ({
    exitCode: 1,
    output: "port refused",
  }));
  await expect(broken.start()).rejects.toMatchObject({
    code: "WEB_SANDBOX_FAILED",
    details: { output: "port refused" },
  });
});

test("a demo Project is committed, registered, then deployed", () => {
  const steps = seedSteps(
    { name: "pantry", deployStable: true, previewBranch: "feat/x" },
    "/site/demo/pantry",
    "/data/pantry",
  );
  expect(steps[0]).toEqual({
    kind: "exec",
    argv: ["cp", "-R", "/site/demo/pantry", "/data/pantry"],
  });
  expect(steps.filter((step) => step.kind === "rig")).toEqual([
    { kind: "rig", args: ["init", "--path", "/data/pantry"] },
    { kind: "rig", args: ["deploy", "live", "--project", "pantry"] },
    {
      kind: "rig",
      args: ["deploy", "preview", "feat/x", "--project", "pantry"],
    },
  ]);
  const registerOnly = seedSteps(
    { name: "quill", deployStable: false },
    "/site/demo/quill",
    "/data/quill",
  );
  expect(registerOnly.at(-1)).toEqual({
    kind: "rig",
    args: ["init", "--path", "/data/quill"],
  });
});

test("seeding skips Projects already present and reports a failure without stopping the rest", async () => {
  const ran: string[] = [];
  const failures = await seedSandbox(
    "/site/demo",
    "/data",
    {
      exists: async (path) => path === "/data/kept",
      run: async (step) => {
        if (step.kind === "rig" && step.args.includes("/data/broken"))
          throw new Error("init refused");
        if (step.kind === "rig") ran.push(step.args.join(" "));
      },
    },
    [
      { name: "kept", deployStable: true },
      { name: "broken", deployStable: true },
      { name: "fine", deployStable: false },
    ],
  );
  expect(failures).toEqual([{ project: "broken", cause: "init refused" }]);
  expect(ran).toEqual(["init --path /data/fine"]);
});

test("shutdown stops every started Target, naming a Preview by its deployment", () => {
  expect(
    downCommands("pantry", [
      { name: "live", kind: "live", state: "healthy" },
      { name: "feat-x-0a1b2c3d", kind: "preview", state: "degraded" },
      { name: "local", kind: "local", state: "configured" },
      { name: "old", kind: "preview", state: "stopped" },
    ]),
  ).toEqual([
    { action: "down", project: "pantry", target: "live" },
    {
      action: "down",
      project: "pantry",
      target: "preview",
      deployment: "feat-x-0a1b2c3d",
    },
  ]);
});

test("a client beyond the trusted addresses signs in with the access key", () => {
  const keyed = accessPolicy({
    publicHost: "rig.b-relay.com",
    port: 4100,
    accessKey: "k".repeat(43),
  });
  const now = 1_800_000_000_000;
  const stranger = { "x-forwarded-for": "100.85.72.39" };
  expect(admit(post(stranger), keyed, { now })).toMatchObject({
    status: 401,
    code: "KEY_REQUIRED",
  });
  // Presenting the key is allowed from anywhere, but still only from the site's own page.
  expect(admit(post(stranger), keyed, { now, signingIn: true })).toEqual({
    admitted: true,
  });
  expect(
    admit(post({ ...stranger, origin: "https://evil.test" }), keyed, {
      now,
      signingIn: true,
    }),
  ).toMatchObject({ code: "ORIGIN" });
  const cookie = `other=1; rig_session=${sessionValue(keyed.accessKey!, now / 1000 + 60)}`;
  expect(admit(post({ ...stranger, cookie }), keyed, { now })).toEqual({
    admitted: true,
  });
  // Loopback needs no key, and a tunnel is refused even with a session.
  expect(
    admit(post({ "x-forwarded-for": "127.0.0.1" }), keyed, { now }),
  ).toEqual({ admitted: true });
  expect(
    admit(post({ ...stranger, cookie, "cf-ray": "1" }), keyed, { now }),
  ).toMatchObject({ code: "CLIENT" });
  // Without a key configured, the old refusal stands.
  expect(
    admit(post({ "x-forwarded-for": "203.0.113.9" }), policy, { now }),
  ).toMatchObject({
    status: 403,
    code: "CLIENT",
  });
});

test("a session is refused once expired, forged, or signed with a replaced key", () => {
  const now = 1_800_000_000_000;
  const expires = now / 1000 + 60;
  const cookie = (value: string) => `rig_session=${value}`;
  expect(signedIn(cookie(sessionValue("key-a", expires)), "key-a", now)).toBe(
    true,
  );
  expect(signedIn(cookie(sessionValue("key-a", expires)), "key-b", now)).toBe(
    false,
  );
  expect(
    signedIn(cookie(sessionValue("key-a", expires)), "key-a", now + 61_000),
  ).toBe(false);
  // Extending the expiry without the key breaks the signature.
  const [, signature] = sessionValue("key-a", expires).split(".");
  expect(signedIn(cookie(`${expires + 999}.${signature}`), "key-a", now)).toBe(
    false,
  );
  expect(
    signedIn(
      `rig_session=planted; ${cookie(sessionValue("key-a", expires))}`,
      "key-a",
      now,
    ),
  ).toBe(true);
  expect(signedIn(null, "key-a", now)).toBe(false);
  expect(signedIn(cookie("junk"), "key-a", now)).toBe(false);
  // A caller that forgets the clock gets no session at all.
  expect(
    admit(
      post({
        "x-forwarded-for": "100.85.72.39",
        cookie: cookie(sessionValue("key-a", expires)),
      }),
      accessPolicy({
        publicHost: "rig.b-relay.com",
        port: 4100,
        accessKey: "key-a",
      }),
    ),
  ).toMatchObject({ code: "KEY_REQUIRED" });
  expect(keyMatches("key-a", "key-a")).toBe(true);
  expect(keyMatches("key-a ", "key-a")).toBe(false);
  expect(keyMatches("", "key-a")).toBe(false);
});

test("a sign-in cookie lasts 400 days from its issue and is renewable", () => {
  const now = 1_800_000_000_000;
  const header = sessionCookie("key-a", now);
  const value = header.split(";")[0]!;
  const days = (count: number) => count * 24 * 60 * 60 * 1000;
  expect(signedIn(value, "key-a", now + days(399))).toBe(true);
  expect(signedIn(value, "key-a", now + days(401))).toBe(false);
  expect(signedIn(value, "key-b", now)).toBe(false);
  expect(header).toContain("Max-Age=34560000");
  expect(header).toContain("HttpOnly; Secure; SameSite=Strict");
  // A visit on day 399 issues a cookie that outlives the first.
  const renewed = sessionCookie("key-a", now + days(399)).split(";")[0]!;
  expect(signedIn(renewed, "key-a", now + days(700))).toBe(true);
});

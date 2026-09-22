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
    by: "client",
  });
  expect(
    admit(
      post({ host: "127.0.0.1:4100", origin: "http://127.0.0.1:4100" }),
      policy,
    ),
  ).toEqual({ admitted: true, by: "client" });
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

test("a change needs a browser origin; a link from elsewhere opens a page but calls nothing", () => {
  expect(
    admit(request("POST", { host: "rig.b-relay.com" }), policy),
  ).toMatchObject({ code: "ORIGIN" });
  const page = (headers: Record<string, string>) =>
    request("GET", {
      host: "rig.b-relay.com",
      "sec-fetch-site": "cross-site",
      ...headers,
    });
  expect(admit(page({ "sec-fetch-mode": "navigate" }), policy).admitted).toBe(
    true,
  );
  expect(admit(page({ "sec-fetch-mode": "cors" }), policy)).toMatchObject({
    code: "ORIGIN",
  });
  expect(
    admit(
      request("POST", {
        host: "rig.b-relay.com",
        origin: "https://rig.b-relay.com",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
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
  ).toEqual({ admitted: true, by: "client" });
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
    by: "signingIn",
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
    by: "session",
  });
  // Loopback needs no key, and a tunnel is refused even with a session.
  expect(
    admit(post({ "x-forwarded-for": "127.0.0.1" }), keyed, { now }),
  ).toEqual({ admitted: true, by: "client" });
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
  const cookie = sessionCookie("key-a", now);
  const { header } = cookie;
  const value = `${cookie.name}=${cookie.value}`;
  const days = (count: number) => count * 24 * 60 * 60 * 1000;
  expect(signedIn(value, "key-a", now + days(399))).toBe(true);
  expect(signedIn(value, "key-a", now + days(401))).toBe(false);
  expect(signedIn(value, "key-b", now)).toBe(false);
  expect(header).toContain("Max-Age=34560000");
  expect(header).toContain("Path=/; HttpOnly; Secure; SameSite=Strict");
  expect(cookie).toMatchObject({
    name: "rig_session",
    maxAge: 34_560_000,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "strict",
  });
  // A visit on day 399 issues a cookie that outlives the first.
  const later = sessionCookie("key-a", now + days(399));
  const renewed = `${later.name}=${later.value}`;
  expect(signedIn(renewed, "key-a", now + days(700))).toBe(true);
});

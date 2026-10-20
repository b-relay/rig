import { test, expect } from "bun:test";
import {
  accessPolicy,
  admit,
  basicPassword,
  keyMatches,
  loopbackHost,
  sessionCookie,
  sessionValue,
  signedIn,
  parseTrustedClients,
  trustedClient,
} from "../web/server/guard";
import { sandboxDaemon } from "../web/server/sandbox";
import { siteSettings } from "../web/server/site";
import { join } from "node:path";
import {
  DEMO_PROJECTS,
  downCommands,
  seedSandbox,
  seedSteps,
} from "../web/server/seed";
import { readProjectConfig, targetOn } from "../src/config";

const KEY = "k".repeat(43);
const NOW = 1_800_000_000_000;
const policy = accessPolicy({
  publicHost: "rig.b-relay.com",
  port: 4100,
  trustedClients: parseTrustedClients("100.64.0.0/10, FD7A::1"),
  accessKey: KEY,
});
/** A Cookie header holding a session `policy`'s key signed, valid at NOW. */
const signedInCookie = `rig_session=${sessionValue(KEY, NOW / 1000 + 60)}`;
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
const at = { now: NOW };

/** An Authorization header presenting `password` the way a browser answers the loopback address's key challenge. */
const basic = (password: string, user = "rig") =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const loopback = { host: "127.0.0.1:4100", origin: "http://127.0.0.1:4100" };

test("the site's own page is admitted with a session under its published name, and with the key on loopback", () => {
  const cookie = signedInCookie;
  expect(
    admit(post({ "x-forwarded-for": "127.0.0.1", cookie }), policy, at),
  ).toEqual({ admitted: true, by: "session" });
  expect(
    admit(post({ ...loopback, authorization: basic(KEY) }), policy, at),
  ).toEqual({ admitted: true, by: "key" });
  expect(
    admit(
      request("GET", { host: "localhost:4100", authorization: basic(KEY, "") }),
      policy,
      at,
    ).admitted,
  ).toBe(true);
});

test("on loopback no cookie counts, since a browser sends it to every port there; only the key itself does", () => {
  for (const headers of [
    { cookie: signedInCookie },
    { authorization: basic("wrong") },
    { authorization: `Bearer ${KEY}` },
    { authorization: basic(KEY).replace("Basic", "Digest") },
  ] as Record<string, string>[])
    expect(admit(post({ ...loopback, ...headers }), policy, at)).toMatchObject({
      status: 401,
      code: "KEY_REQUIRED",
    });
  // Nor does presenting the key to signIn: on loopback there is nothing for it to hand out.
  expect(
    admit(post(loopback), policy, { ...at, signingIn: true }),
  ).toMatchObject({ code: "KEY_REQUIRED" });
  // The key works only on loopback; under the published name it takes the session cookie.
  expect(admit(post({ authorization: basic(KEY) }), policy, at)).toMatchObject({
    code: "KEY_REQUIRED",
  });
  expect(basicPassword(basic("a:b:c"))).toBe("a:b:c");
  expect(basicPassword("Basic !!!")).toBeUndefined();
  expect(basicPassword(null)).toBeUndefined();
});

test("being on this Mac or a trusted address is no sign-in: without a session it is sent to sign in", () => {
  for (const headers of [
    loopback,
    { "x-forwarded-for": "127.0.0.1" },
    { "x-forwarded-for": "100.101.102.103" },
  ] as Record<string, string>[])
    expect(admit(post(headers), policy, at)).toMatchObject({
      status: 401,
      code: "KEY_REQUIRED",
    });
  // Without an access key no browser can sign in, so none is admitted.
  const keyless = accessPolicy({ port: 4100 });
  expect(
    admit(request("GET", { host: "127.0.0.1:4100" }), keyless, at),
  ).toMatchObject({ status: 403, code: "NO_ACCESS_KEY" });
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
  expect(
    admit(
      page({ "sec-fetch-mode": "navigate", cookie: signedInCookie }),
      policy,
      at,
    ).admitted,
  ).toBe(true);
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

test("a trusted list limits the site to loopback and its addresses, session or not, and every forwarded hop must be in it", () => {
  const cookie = signedInCookie;
  // An empty list limits nothing: any address signs in with the key, and still needs it.
  const open = accessPolicy({
    publicHost: "rig.b-relay.com",
    port: 4100,
    accessKey: KEY,
  });
  expect(
    admit(post({ "x-forwarded-for": "203.0.113.9" }), open, at),
  ).toMatchObject({ status: 401, code: "KEY_REQUIRED" });
  expect(
    admit(post({ "x-forwarded-for": "203.0.113.9" }), open, {
      ...at,
      signingIn: true,
    }),
  ).toEqual({ admitted: true, by: "signingIn" });
  expect(
    admit(post({ "x-forwarded-for": "203.0.113.9", cookie }), open, at),
  ).toEqual({ admitted: true, by: "session" });
  for (const signedIn of [{}, { cookie }] as Record<string, string>[])
    expect(
      admit(post({ "x-forwarded-for": "203.0.113.9", ...signedIn }), policy, {
        ...at,
        signingIn: true,
      }),
    ).toMatchObject({ status: 403, code: "CLIENT" });
  expect(
    admit(post({ "x-forwarded-for": "100.101.102.103", cookie }), policy, at)
      .admitted,
  ).toBe(true);
  expect(
    admit(
      post({ "x-forwarded-for": "127.0.0.1, 203.0.113.9", cookie }),
      policy,
      at,
    ),
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
    accessKey: KEY,
    trustedClients: parseTrustedClients("100.64.0.0/10"),
  });
  expect(sandboxed.relaysAt).toBeUndefined();
  expect(
    admit(
      post({
        host: "feature.rig.b-relay.com",
        origin: "https://feature.rig.b-relay.com",
        "x-forwarded-for": "127.0.0.1",
        cookie: signedInCookie,
      }),
      sandboxed,
      at,
    ),
  ).toEqual({ admitted: true, by: "session" });
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
    { kind: "rig", args: ["deploy", "stable", "--project", "pantry"] },
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

test("every demo Project's rig.yaml turns on each Target its seed deploys", async () => {
  for (const project of DEMO_PROJECTS) {
    const { config } = await readProjectConfig(
      join(import.meta.dir, "..", "web", "demo", project.name),
    );
    expect(targetOn(config, "stable")).toBe(project.deployStable);
    expect(targetOn(config, "preview")).toBe(
      project.previewBranch !== undefined,
    );
    expect(targetOn(config, "working")).toBe(true);
  }
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

test("shutdown stops every started Target, naming a Preview by its deployment and the others by their role", () => {
  expect(
    downCommands("pantry", [
      // Selected by its role, whatever name the report carries.
      { name: "live", kind: "stable", state: "healthy" },
      { name: "feat-x-0a1b2c3d", kind: "preview", state: "degraded" },
      { name: "working", kind: "working", state: "configured" },
      { name: "old", kind: "preview", state: "stopped" },
    ]),
  ).toEqual([
    { action: "down", project: "pantry", target: "stable" },
    {
      action: "down",
      project: "pantry",
      target: "preview",
      deployment: "feat-x-0a1b2c3d",
    },
  ]);
});

test("this Mac and a trusted client sign in with the access key", () => {
  const now = NOW;
  const cookie = `other=1; ${signedInCookie}`;
  for (const client of [
    {},
    { "x-forwarded-for": "127.0.0.1" },
    { "x-forwarded-for": "100.85.72.39" },
  ] as Record<string, string>[]) {
    expect(admit(post(client), policy, { now })).toMatchObject({
      status: 401,
      code: "KEY_REQUIRED",
    });
    // Presenting the key is allowed, but only from the site's own page.
    expect(admit(post(client), policy, { now, signingIn: true })).toEqual({
      admitted: true,
      by: "signingIn",
    });
    expect(
      admit(post({ ...client, origin: "https://evil.test" }), policy, {
        now,
        signingIn: true,
      }),
    ).toMatchObject({ code: "ORIGIN" });
    expect(admit(post({ ...client, cookie }), policy, { now })).toEqual({
      admitted: true,
      by: "session",
    });
    // A tunnel is refused even with a session.
    expect(
      admit(post({ ...client, cookie, "cf-ray": "1" }), policy, { now }),
    ).toMatchObject({ code: "CLIENT" });
  }
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
      post({ cookie: cookie(sessionValue("key-a", expires)) }),
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
  expect(header).toContain("Path=/; HttpOnly; Secure; SameSite=Lax");
  expect(cookie).toMatchObject({
    name: "rig_session",
    maxAge: 34_560_000,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
  });
  expect(loopbackHost("127.0.0.1:4100")).toBe(true);
  expect(loopbackHost("localhost:4100")).toBe(true);
  expect(loopbackHost("rig.b-relay.com")).toBe(false);
  expect(loopbackHost("127.0.0.1.evil.test:4100")).toBe(false);
  expect(loopbackHost(null)).toBe(false);
  // A visit on day 399 issues a cookie that outlives the first.
  const later = sessionCookie("key-a", now + days(399));
  const renewed = `${later.name}=${later.value}`;
  expect(signedIn(renewed, "key-a", now + days(700))).toBe(true);
});

test("the site takes its repository from RIG_WEB_REPOSITORY, since the assembled server runs from inside its build, and from its directory otherwise", async () => {
  const env = { PORT: "4280" };
  expect(
    siteSettings(env, "/home", "/checkout/.dashboard/web").repository,
  ).toBe("/checkout/.dashboard/web");
  expect(
    siteSettings(
      { ...env, RIG_WEB_REPOSITORY: "/checkout" },
      "/home",
      "/checkout/.dashboard/web",
    ).repository,
  ).toBe("/checkout");
  // Rig's own rig.yaml names the checkout for it.
  const config = await readProjectConfig(join(import.meta.dir, ".."));
  expect(config.config.services!.web!.environment).toMatchObject({
    RIG_WEB_REPOSITORY: "${rig.workspace}",
  });
});

import { expect, mock, test } from "bun:test";
import { SITE, local, session, throughCaddy } from "./support/dashboard-site";
import { NextRequest } from "next/server";
import * as proxyModule from "../web/proxy";

/** Who reaches the dashboard: every page, Server Action and route takes a session, from this Mac as from anywhere
 * else; where a request comes from only decides whether it may reach the site and sign in at all. Requests go through
 * the real proxy and actions against a site with an access key, published at rig.example.test and trusting
 * 100.64.0.0/10; Next's request headers are stood in for, and the Rig root has no rigd. */

let requestHeaders = new Headers();
const jar: { name: string; secure: boolean }[] = [];
mock.module("next/headers", () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({
    get: () => undefined,
    set: (cookie: { name: string; secure: boolean }) => jar.push(cookie),
  }),
}));
const { runCommand, runEnvEdit, signIn } =
  await import("../web/server/actions");
const { daemon } = await import("../web/server/daemon");

const TRUSTED = "100.101.102.103";
const STRANGER = "203.0.113.9";
const url = (headers: Record<string, string>, path: string) =>
  `${headers.origin ?? `http://${headers.host}`}${path}`;
const page = (headers: Record<string, string>, path = "/projects/pantry") =>
  proxyModule.proxy(
    new NextRequest(url(headers, path), {
      headers: { ...headers, "sec-fetch-mode": "navigate" },
    }),
  );
const rsc = (headers: Record<string, string>) =>
  proxyModule.proxy(
    new NextRequest(url(headers, "/projects/pantry?_rsc=1"), {
      headers: { ...headers, rsc: "1" },
    }),
  );
const action = (headers: Record<string, string>, path = "/projects/pantry") =>
  proxyModule.proxy(
    new NextRequest(url(headers, path), {
      method: "POST",
      headers: {
        ...headers,
        "next-action": "7f00",
        "content-type": "text/plain",
      },
      body: "[]",
    }),
  );
const route = (headers: Record<string, string>, path = "/pulse") =>
  proxyModule.proxy(
    new NextRequest(url(headers, path), {
      headers: { ...headers, "sec-fetch-mode": "cors" },
    }),
  );
const passed = (answer: Response) =>
  answer.headers.get("x-middleware-next") === "1";
const toSignIn = (answer: Response) =>
  answer.status === 303 &&
  new URL(answer.headers.get("location")!).pathname === "/sign-in";
/** Runs a Server Action as a page sending `headers` would. */
const asPage = async <T>(
  headers: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> => {
  requestHeaders = new Headers(headers);
  return run();
};
const list = { action: "list", operationId: "op-1" } as const;

for (const [where, headers] of [
  ["this Mac, directly", local()],
  ["this Mac, through Caddy", throughCaddy("127.0.0.1")],
] as const) {
  test(`a request from ${where} without a session reaches no page, action or route`, async () => {
    expect(toSignIn(await page(headers))).toBe(true);
    expect(toSignIn(await page(headers, "/"))).toBe(true);
    expect(toSignIn(await rsc(headers))).toBe(true);
    expect(toSignIn(await route(headers))).toBe(true);
    expect(toSignIn(await route(headers, "/log-lines?q=%7B%7D"))).toBe(true);
    const refused = await action(headers);
    expect(passed(refused)).toBe(false);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({
      error: { code: "KEY_REQUIRED" },
    });
    // The actions decide again by themselves, and rigd itself is out of reach without a session.
    expect(await asPage(headers, () => runCommand(list))).toMatchObject({
      ok: false,
      failure: { code: "KEY_REQUIRED" },
    });
    expect(
      await asPage(headers, () =>
        runEnvEdit({ action: "reveal", project: "pantry", name: "TOKEN" }),
      ),
    ).toMatchObject({ ok: false, failure: { code: "KEY_REQUIRED" } });
    await expect(asPage(headers, () => daemon())).rejects.toMatchObject({
      code: "SIGN_IN_REQUIRED",
    });
    // The sign-in page and its own action stay open to it.
    expect(passed(await page(headers, "/sign-in"))).toBe(true);
    expect(passed(await action(headers, "/sign-in"))).toBe(true);
  });
}

test("a trusted address without a session is sent to sign in, and reaches no action or route", async () => {
  const headers = throughCaddy(TRUSTED);
  expect(toSignIn(await page(headers))).toBe(true);
  expect(toSignIn(await route(headers))).toBe(true);
  expect((await action(headers)).status).toBe(401);
  expect(await asPage(headers, () => runCommand(list))).toMatchObject({
    ok: false,
    failure: { code: "KEY_REQUIRED" },
  });
  expect(passed(await page(headers, "/sign-in"))).toBe(true);
  expect(passed(await action(headers, "/sign-in"))).toBe(true);
});

test("an address outside the trusted list is refused outright, sign-in and session included", async () => {
  for (const headers of [
    throughCaddy(STRANGER),
    { ...throughCaddy(STRANGER), cookie: session() },
    // Every forwarded hop must be trusted.
    throughCaddy(`${TRUSTED}, ${STRANGER}`),
  ]) {
    for (const answer of [
      await page(headers),
      await page(headers, "/sign-in"),
      await action(headers, "/sign-in"),
      await route(headers),
    ]) {
      expect(answer.status).toBe(403);
      expect(await answer.json()).toMatchObject({
        error: { code: "CLIENT" },
      });
    }
    expect(await asPage(headers, () => signIn(SITE.key))).toMatchObject({
      ok: false,
      failure: { code: "CLIENT" },
    });
  }
});

test("a path that only starts like a public one is decided like any page, and carries the CSP", async () => {
  const matcher = (proxyModule as { config?: { matcher?: readonly string[] } })
    .config?.matcher;
  const runsOn = (path: string) =>
    !matcher || matcher.some((source) => new RegExp(`^${source}$`).test(path));
  for (const path of [
    "/healthzz",
    "/healthz-private",
    "/healthz/x",
    "/favicon.icon",
    "/favicon.ico.html",
    "/_next/staticx",
    "/_next/static",
    "/_next/image",
    "/_next/imagex",
    "/no-such-page",
  ]) {
    expect(runsOn(path)).toBe(true);
    const answer = await page(throughCaddy(TRUSTED), path);
    expect(toSignIn(answer)).toBe(true);
    expect(answer.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
  }
});

test("the readiness probe and the build's static files need no session, and carry the CSP too", async () => {
  for (const path of [
    "/healthz",
    "/favicon.ico",
    "/_next/static/chunks/main.js",
    "/_next/static/missing",
  ]) {
    const answer = await page(throughCaddy(STRANGER), path);
    expect(passed(answer)).toBe(true);
    expect(answer.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  }
});

test("a valid session reaches every page, action and route, from this Mac and from a trusted address", async () => {
  for (const headers of [
    { ...local(), cookie: session() },
    { ...throughCaddy("127.0.0.1"), cookie: session() },
    { ...throughCaddy(TRUSTED), cookie: session() },
  ]) {
    for (const answer of [
      await page(headers),
      await page(headers, "/"),
      await rsc(headers),
      await action(headers),
      await route(headers),
      await route(headers, "/usage"),
    ]) {
      expect(passed(answer)).toBe(true);
      expect(answer.headers.get("content-security-policy")).toContain("nonce-");
      expect(answer.headers.get("set-cookie")).toContain("rig_session=");
    }
    // Past every check to rigd's door: this Rig root runs no rigd.
    expect(await asPage(headers, () => runCommand(list))).toMatchObject({
      ok: false,
      failure: { code: "DAEMON_MISSING" },
    });
  }
});

test("the key signs a browser in from this Mac and from a trusted address, Secure only over HTTPS", async () => {
  jar.length = 0;
  expect(await asPage(local(), () => signIn("wrong"))).toMatchObject({
    ok: false,
    failure: { code: "KEY_REFUSED" },
  });
  expect(await asPage(local(), () => signIn(SITE.key))).toEqual({
    ok: true,
    value: { signedIn: true },
  });
  expect(
    await asPage(throughCaddy(TRUSTED), () => signIn(SITE.key)),
  ).toMatchObject({ ok: true });
  expect(jar).toMatchObject([
    { name: "rig_session", secure: false },
    { name: "rig_session", secure: true },
  ]);
  const renewed = (headers: Record<string, string>) =>
    page({ ...headers, cookie: session() }).then(
      (answer) => answer.headers.get("set-cookie") ?? "",
    );
  expect(await renewed(local())).not.toContain("Secure");
  expect(await renewed(throughCaddy(TRUSTED))).toContain("Secure");
});

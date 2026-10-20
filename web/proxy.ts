import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import {
  admit,
  loopbackHost,
  sessionCookie,
  type AccessPolicy,
} from "./server/guard";
import { sitePolicy } from "./server/site";
import { returnPath } from "./lib/return-path";
/** Runs for every request (there is no matcher): decides every page, action and route before Next renders anything. */
export async function proxy(request: NextRequest) {
  return guard(request, await sitePolicy(), Date.now());
}
/** Pure: whether a path is served without a session: the readiness probe, the icon a browser asks for, and the
 * build's own scripts, styles and fonts, which the sign-in page needs and which hold nothing about rigd. Exact, so a
 * path that only starts like one is decided like any page. */
export const publicPath = (pathname: string): boolean =>
  pathname === "/healthz" ||
  pathname === "/favicon.ico" ||
  pathname.startsWith("/_next/static/");
/** Decides one request under `policy` at `now` (epoch milliseconds). Every response carries the
 * Content-Security-Policy, public and not-found ones included, and each page gets the nonce its
 * scripts run under. */
export function guard(
  request: NextRequest,
  policy: AccessPolicy,
  now: number,
): NextResponse {
  const nonce = randomBytes(16).toString("base64");
  const csp = [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", csp);
  if (publicPath(request.nextUrl.pathname)) {
    const answer = NextResponse.next({ request: { headers: requestHeaders } });
    answer.headers.set("content-security-policy", csp);
    return answer;
  }
  const admission = admit(request, policy, { now });
  const answer = decide(request, admission, requestHeaders);
  answer.headers.set("content-security-policy", csp);
  answer.headers.set("cache-control", "no-store");
  // A browser in use never reaches its session's expiry: each admitted visit renews it.
  if (admission.admitted && admission.by === "session" && policy.accessKey)
    answer.headers.set(
      "set-cookie",
      sessionCookie(
        policy.accessKey,
        now,
        !loopbackHost(request.headers.get("host")),
      ).header,
    );
  return answer;
}
/** An admitted request proceeds. A browser that only lacks a session is sent to the sign-in
 * page, and the sign-in page's own Server Action reaches Next so that `signIn` can accept the
 * key. Anything else is refused here. */
export function decide(
  request: NextRequest,
  admission: ReturnType<typeof admit>,
  requestHeaders: Headers,
): NextResponse {
  if (admission.admitted) {
    // A browser that is already signed in has nothing to do on the sign-in page: send it on to where it was going.
    if (request.method === "GET" && request.nextUrl.pathname === "/sign-in") {
      const onward = new URL(
        returnPath(request.nextUrl.searchParams.get("next")),
        request.url,
      );
      // returnPath keeps it on this site; checked again so no parser difference can send a visitor elsewhere.
      return NextResponse.redirect(
        onward.origin === request.nextUrl.origin
          ? onward
          : new URL("/", request.url),
        303,
      );
    }
    return NextResponse.next({ request: { headers: requestHeaders } });
  }
  if (admission.code === "KEY_REQUIRED") {
    const { pathname, search } = request.nextUrl;
    const signInPage = pathname === "/sign-in";
    if (
      signInPage &&
      (request.method === "GET" ||
        (request.method === "POST" && request.headers.has("next-action")))
    )
      return NextResponse.next({ request: { headers: requestHeaders } });
    if (request.method === "GET") {
      // A redirect rather than a rewrite: Next spells 127.0.0.1 as localhost in a rewrite's
      // URL and then, seeing a host other than the one it listens on, proxies it over the
      // network. The browser resolves this relative Location against the address it used.
      const signIn = new URL("/sign-in", request.url);
      if (pathname !== "/") signIn.searchParams.set("next", pathname + search);
      return NextResponse.redirect(signIn, 303);
    }
  }
  return NextResponse.json(
    { error: { code: admission.code, message: admission.message } },
    { status: admission.status },
  );
}

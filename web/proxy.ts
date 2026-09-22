import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { admit, sessionCookie } from "./server/guard";
import { SIGNING_IN_HEADER } from "./server/signing-in";
import { sitePolicy } from "./server/site";
/** Decides every page and action before Next renders anything, and gives each page the nonce
 * its scripts run under. Static assets and the readiness probe are excluded by the matcher. */
export async function proxy(request: NextRequest) {
  const policy = await sitePolicy();
  const now = Date.now();
  const admission = admit(request, policy, { now });
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
  requestHeaders.delete(SIGNING_IN_HEADER);
  const answer = decide(request, admission, requestHeaders);
  answer.headers.set("content-security-policy", csp);
  answer.headers.set("cache-control", "no-store");
  // A browser in use never reaches its session's expiry: each admitted visit renews it.
  if (admission.admitted && admission.by === "session" && policy.accessKey)
    answer.headers.set(
      "set-cookie",
      sessionCookie(policy.accessKey, now).header,
    );
  return answer;
}
/** An admitted request proceeds. A browser that only lacks a session is sent to the sign-in
 * page, which is served to it with none of the site's frame, and its Server Actions reach Next
 * so that `signIn` can accept the key; every other action refuses again by itself. Anything
 * else is refused here. */
function decide(
  request: NextRequest,
  admission: ReturnType<typeof admit>,
  requestHeaders: Headers,
): NextResponse {
  if (admission.admitted)
    return NextResponse.next({ request: { headers: requestHeaders } });
  if (admission.code === "KEY_REQUIRED") {
    requestHeaders.set(SIGNING_IN_HEADER, "1");
    const { pathname, search } = request.nextUrl;
    if (request.method === "GET" && pathname === "/sign-in")
      return NextResponse.next({ request: { headers: requestHeaders } });
    if (request.method === "GET") {
      // A redirect rather than a rewrite: Next spells 127.0.0.1 as localhost in a rewrite's
      // URL and then, seeing a host other than the one it listens on, proxies it over the
      // network. The browser resolves this relative Location against the address it used.
      const signIn = new URL("/sign-in", request.url);
      if (pathname !== "/") signIn.searchParams.set("next", pathname + search);
      return NextResponse.redirect(signIn, 303);
    }
    if (request.method === "POST" && request.headers.has("next-action"))
      return NextResponse.next({ request: { headers: requestHeaders } });
  }
  return NextResponse.json(
    { error: { code: admission.code, message: admission.message } },
    { status: admission.status },
  );
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|healthz).*)"],
};

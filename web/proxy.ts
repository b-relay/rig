import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { admit, sessionCookie } from "./server/guard";
import { sitePolicy } from "./server/site";

/** Decides every page and action before Next renders anything, and gives each page the nonce
 * its scripts run under. Static assets and the readiness probe are excluded by the matcher. */
export async function proxy(request: NextRequest) {
  const policy = await sitePolicy();
  const now = Date.now();
  const signingIn = request.nextUrl.pathname === "/sign-in";
  const admission = admit(request, policy, { now, signingIn });
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
  const answer =
    admission.admitted ||
    (admission.code === "KEY_REQUIRED" &&
      !signingIn &&
      request.method === "GET")
      ? admission.admitted
        ? NextResponse.next({ request: { headers: requestHeaders } })
        : NextResponse.rewrite(new URL("/sign-in", request.url), {
            request: { headers: requestHeaders },
            status: 401,
          })
      : NextResponse.json(
          { error: { code: admission.code, message: admission.message } },
          { status: admission.status },
        );
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
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|healthz).*)"],
};

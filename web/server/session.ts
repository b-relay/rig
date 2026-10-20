import { headers } from "next/headers";
import { RigError } from "../../src/domain/errors";
import { admit } from "./guard";
import { sitePolicy } from "./site";

/** Whether the request being served holds a valid session, or on the loopback address the key itself. Decided again from the request itself rather than taken
 * from the proxy, so a page Next renders for a path the proxy lets through without one (a missing static file's
 * not-found page) still learns nothing about rigd. */
export async function sessionHeld(): Promise<boolean> {
  const decision = admit(
    { method: "GET", headers: await headers() },
    await sitePolicy(),
    { now: Date.now() },
  );
  return decision.admitted && decision.by !== "signingIn";
}
/** Refuses unless the request being served holds a valid session: every read of rigd and every change to it passes
 * here, whatever page, route or action asked. */
export async function requireSession(): Promise<void> {
  if (!(await sessionHeld()))
    throw new RigError(
      "SIGN_IN_REQUIRED",
      "This request holds no dashboard session, so it reaches nothing of rigd.",
      "Sign in with this Host's access key.",
    );
}

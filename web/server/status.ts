import { cache } from "react";
import { RigError } from "../../src/domain/errors";
import { attempt, type Failure, type Outcome } from "../lib/outcome";
import type {
  BackupsResult,
  ListResult,
  ProjectStatusReport,
} from "../lib/types";
import { read } from "./daemon";

/** A read's refusal thrown as rigd gave it, so a page's `settled` read or its error boundary shows the code, message,
 * hint, Operation and field problems. Each field problem's path goes back to segments, as rigd sends it, so reading
 * the refusal again gives the same dotted path. */
export function refusalError(failure: Failure): RigError {
  return new RigError(
    failure.code,
    failure.message,
    failure.hint ?? "Run 'rigd status' to inspect the daemon.",
    {
      ...(failure.operationId ? { operationId: failure.operationId } : {}),
      ...(failure.issues
        ? {
            issues: failure.issues.map(({ path, message }) => ({
              path: path.split("."),
              message,
            })),
          }
        : {}),
    },
  );
}
/** The Projects this Host has registered, read once per request however many parts of the page ask. */
export const projectList = cache((): Promise<Outcome<ListResult>> =>
  attempt(read({ action: "list" })),
);
/** One Project's status read of this request, and when it began (`performance.now()`), so a status kept beyond the
 * request can say how fresh it is. */
export const projectStatusRead = cache(
  (
    project: string,
  ): { began: number; outcome: Promise<Outcome<ProjectStatusReport>> } => ({
    began: performance.now(),
    outcome: attempt(read({ action: "status", project })),
  }),
);
/** One Project's status, read once per request: the sidebar and the page share the observation
 * rather than each paying rigd's two-second budget. */
export const projectStatus = (
  project: string,
): Promise<Outcome<ProjectStatusReport>> => projectStatusRead(project).outcome;
/** What Rig's own Caddy serves and the operator's custom file, read once per request; PROXY_UNMANAGED
 * when the Host's Caddy serves Rig's routes instead. */
export const proxyReport = cache(() => attempt(read({ action: "proxy" })));
/** A Project's kept backups (ADR 0017), every Target's, read once per request. */
export const projectBackups = cache(
  (project: string): Promise<Outcome<BackupsResult>> =>
    attempt(read({ action: "backups", project })),
);
/** Every DNS record of the zones Rig manages and where each served hostname points (ADR 0018), read once per request.
 * rigd reads the provider token; the page never sees it. DNS_UNCONFIGURED or DNS_TOKEN when it is not set up. */
export const dnsReport = cache(() => attempt(read({ action: "dns" })));

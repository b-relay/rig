import { cache } from "react";
import { attempt, type Outcome } from "../lib/outcome";
import type {
  BackupsResult,
  ListResult,
  ProjectStatusReport,
} from "../lib/types";
import { read } from "./daemon";

/** The Projects this Host has registered, read once per request however many parts of the page ask. */
export const projectList = cache((): Promise<Outcome<ListResult>> =>
  attempt(read({ action: "list" })),
);
/** One Project's status, read once per request: the sidebar and the page share the observation
 * rather than each paying rigd's two-second budget. */
export const projectStatus = cache(
  (project: string): Promise<Outcome<ProjectStatusReport>> =>
    attempt(read({ action: "status", project })),
);
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

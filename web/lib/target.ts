import type { RuntimeCommand, TargetReport } from "./types";

/** How a command names a Target from a status report: a Preview by its deployment name, working and stable by their role. */
export function targetSelector(
  target: Pick<TargetReport, "kind" | "name">,
): Pick<RuntimeCommand, "target" | "deployment"> {
  return target.kind === "preview"
    ? { target: "preview", deployment: target.name }
    : { target: target.kind };
}
/** The inverse for a `<select>`: one string per Target. */
export const targetKey = (target: Pick<TargetReport, "kind" | "name">) =>
  `${target.kind}:${target.name}`;
/** A route as rigd records it is a bare host name; a link needs the scheme Caddy serves it on. */
export const routeUrl = (route: string): string =>
  /^https?:\/\//.test(route) ? route : `https://${route}`;
/** A Project's page. */
export const projectHref = (project: string) =>
  `/projects/${encodeURIComponent(project)}`;
/** A Target's page under its Project. A Target's name is unique within its Project: `working`, `stable`, or a Preview's name. */
export const targetHref = (project: string, target: string) =>
  `${projectHref(project)}/targets/${encodeURIComponent(target)}`;

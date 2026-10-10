import type { TargetReport } from "./types";

/** What the dashboard can ask rigd to do to one Target. `deploy` deploys the head Commit again:
 * the Production Branch's for the stable Target, the Preview's own Branch for a Preview. */
export type TargetVerb = "up" | "restart" | "down" | "deploy" | "destroy";

/** Pure: the actions a Target offers. `all` is every one that applies to its role; `primary` the
 * few its state calls for, shown as buttons: a stopped Target is started, a running one restarted or
 * stopped, and a deployed role can always be deployed again. A stable Target that was never deployed
 * offers only a deploy, since there is nothing to start yet. */
export function targetVerbs(
  target: Pick<TargetReport, "kind" | "state" | "branch">,
): { primary: TargetVerb[]; all: TargetVerb[] } {
  const deployable =
    target.kind === "stable" ||
    (target.kind === "preview" && target.branch !== undefined);
  const all: TargetVerb[] = [
    "up",
    "restart",
    "down",
    ...(deployable ? (["deploy"] as const) : []),
    ...(target.kind === "preview" ? (["destroy"] as const) : []),
  ];
  if (target.state === "configured")
    return {
      primary:
        target.kind === "working" ? ["up"] : deployable ? ["deploy"] : [],
      all: target.kind === "working" ? ["up"] : all,
    };
  const stopped = ["stopped", "failed"].includes(target.state);
  return {
    primary: [
      ...(stopped ? (["up"] as const) : (["restart", "down"] as const)),
      ...(deployable ? (["deploy"] as const) : []),
    ],
    all,
  };
}

import type { DeploymentReport, RuntimeCommand, TargetReport } from "./types";

/** One row of the deploy history: the recorded deploy and what the page can do with it. */
export interface DeploymentRow extends DeploymentReport {
  /** This deploy put the Commit the Target runs now (its newest successful deploy of that Commit). */
  current: boolean;
  /** Deploying this Commit again would change the Target: it deployed successfully, its Target still
   * exists, and the Target runs another Commit now. */
  rollback: boolean;
}
/** Pure: the history newest first, each deploy marked as the one running now or one the Target can
 * be rolled back to. A deploy whose Target was destroyed stays in the list, but cannot be rolled back. */
export function deploymentRows(
  history: readonly DeploymentReport[],
  targets: readonly Pick<TargetReport, "name" | "commit">[],
): DeploymentRow[] {
  const running = new Map(targets.map((each) => [each.name, each.commit]));
  const marked = new Set<string>();
  return [...history].reverse().map((deploy) => {
    const succeeded =
      deploy.outcome === "deployed" || deploy.outcome === "unchanged";
    const now = running.get(deploy.target);
    const current =
      succeeded &&
      deploy.commit !== undefined &&
      deploy.commit === now &&
      !marked.has(deploy.target);
    if (current) marked.add(deploy.target);
    return {
      ...deploy,
      current,
      rollback:
        succeeded &&
        running.has(deploy.target) &&
        deploy.commit !== undefined &&
        deploy.branch !== undefined &&
        deploy.commit !== now,
    };
  });
}
/** Pure: the deploy command that puts an earlier deploy's Commit back on its Target. */
export function rollbackCommand(
  project: string,
  deploy: Pick<DeploymentReport, "target" | "kind" | "branch" | "commit">,
): RuntimeCommand {
  return {
    action: "deploy",
    project,
    ...(deploy.kind === "preview"
      ? { target: "preview", deployment: deploy.target }
      : { target: "stable" }),
    ...(deploy.branch ? { branch: deploy.branch } : {}),
    ...(deploy.commit ? { commit: deploy.commit } : {}),
  };
}
/** Pure: a duration in the two largest units that say something: 850 ms, 12 s, 3 min 4 s, 1 h 2 min. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

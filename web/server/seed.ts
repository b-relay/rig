import { join } from "node:path";

/** One demo Project a sandbox starts with; `name` is its directory under `web/demo` and its Project name. */
export interface DemoProject {
  name: string;
  /** Deploy the Stable Target so the dashboard opens on something running. */
  deployStable: boolean;
  /** A Branch to deploy as a Preview, made with one empty Commit on top of main. */
  previewBranch?: string;
}
export const DEMO_PROJECTS: readonly DemoProject[] = [
  { name: "pantry", deployStable: true, previewBranch: "feat/shopping-list" },
  { name: "ledger", deployStable: true },
  { name: "quill", deployStable: false },
];
/** One command of the seed: `rig` steps run the CLI against the sandbox root, the rest run as written. */
export type SeedStep =
  { kind: "exec"; argv: string[] } | { kind: "rig"; args: string[] };

/** Pure: the ordered steps that turn the demo files at `source` into a registered Project whose
 * repository is `repository`. A deploy reads a Commit, so the files are committed first. */
export function seedSteps(
  project: DemoProject,
  source: string,
  repository: string,
): SeedStep[] {
  const git = (...args: string[]): SeedStep => ({
    kind: "exec",
    argv: [
      "git",
      "-C",
      repository,
      "-c",
      "user.name=Rig demo",
      "-c",
      "user.email=demo@rig.invalid",
      ...args,
    ],
  });
  const rig = (...args: string[]): SeedStep => ({ kind: "rig", args });
  const selector = ["--project", project.name];
  return [
    { kind: "exec", argv: ["cp", "-R", source, repository] },
    git("init", "-q", "-b", "main"),
    git("add", "-A"),
    git("commit", "-q", "-m", `feat: start ${project.name}`),
    rig("init", "--path", repository),
    ...(project.deployStable ? [rig("deploy", "live", ...selector)] : []),
    ...(project.previewBranch
      ? [
          git("checkout", "-q", "-b", project.previewBranch),
          git("commit", "-q", "--allow-empty", "-m", "feat: try an idea"),
          git("checkout", "-q", "main"),
          rig("deploy", "preview", project.previewBranch, ...selector),
        ]
      : []),
  ];
}
export interface SeedDependencies {
  exists(path: string): Promise<boolean>;
  /** Runs one step to completion; rejects when it fails. */
  run(step: SeedStep): Promise<void>;
}
/** Seeds every demo Project that has no repository under `projectsRoot` yet, so a restarted sandbox
 * keeps what the visitor did to it. Answers with one entry per Project whose seeding failed; a
 * failed Project does not stop the others. */
export async function seedSandbox(
  demoRoot: string,
  projectsRoot: string,
  dependencies: SeedDependencies,
  projects: readonly DemoProject[] = DEMO_PROJECTS,
): Promise<{ project: string; cause: string }[]> {
  const failures: { project: string; cause: string }[] = [];
  for (const project of projects) {
    const repository = join(projectsRoot, project.name);
    if (await dependencies.exists(repository)) continue;
    try {
      for (const step of seedSteps(
        project,
        join(demoRoot, project.name),
        repository,
      ))
        await dependencies.run(step);
    } catch (error) {
      failures.push({
        project: project.name,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failures;
}
/** One `down` command for the sandbox rigd's control plane. */
export interface DownCommand {
  action: "down";
  project: string;
  target: string;
  deployment?: string;
}
/** Pure: the commands that stop every Target a status report shows as started, so the sandbox
 * rigd agrees to uninstall. A Preview is named by its deployment; other Targets by name. */
export function downCommands(
  project: string,
  targets: readonly { name: string; kind: string; state: string }[],
): DownCommand[] {
  return targets
    .filter((target) => !["configured", "stopped"].includes(target.state))
    .map((target) =>
      target.kind === "preview"
        ? {
            action: "down",
            project,
            target: "preview",
            deployment: target.name,
          }
        : { action: "down", project, target: target.name },
    );
}

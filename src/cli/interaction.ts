import { z } from "zod";
import { terminalText } from "./terminal-text";
import { RigError } from "../domain/errors";
import type { RuntimeCommand } from "../daemon/protocol";
import type { CliDependencies } from "./types";
export interface CliInteraction {
  select(
    message: string,
    choices: readonly { value: string; label: string }[],
  ): Promise<string>;
  text(message: string, defaultValue: string): Promise<string>;
  confirm(message: string): Promise<boolean>;
}
const targets = z.object({
  targets: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["local", "live", "preview"]),
      state: z.string(),
    }),
  ),
});
const initialization = z.object({
  name: z.string(),
  productionBranch: z.string(),
  gitRequired: z.boolean(),
  existing: z.boolean(),
});
const deployment = z.object({
  productionBranch: z.string(),
  currentBranch: z.string().nullable(),
});
/** Resolve human choices through read-only daemon queries before submitting any mutation. */
export async function prepareInteractiveRequest(
  request: RuntimeCommand,
  deps: CliDependencies,
): Promise<RuntimeCommand> {
  assertActive(deps.signal);
  const interaction = deps.interaction;
  if (
    ["up", "down", "restart", "logs"].includes(request.action) &&
    !request.target
  ) {
    if (!interaction)
      throw new RigError(
        "TARGET_REQUIRED",
        "Choose a Target explicitly.",
        "Pass local, live, or preview <branch>; interactive terminals offer a Target picker.",
      );
    const report = readReply(
      targets,
      await deps.client.command({
        action: "status",
        project: request.project,
        repoPath: request.repoPath,
      }),
    );
    assertActive(deps.signal);
    if (!report.targets.length)
      throw new RigError(
        "TARGET_REQUIRED",
        "This Project has no available Targets.",
        "Configure a local Target or deploy a Branch first.",
      );
    const name = await interaction.select(
      "Choose a Target",
      report.targets.map((target) => ({
        value: target.name,
        label: `${target.name} (${target.state})`,
      })),
    );
    assertActive(deps.signal);
    const selected = report.targets.find((target) => target.name === name);
    if (!selected)
      throw new RigError(
        "CANCELLED",
        "No Target was selected.",
        "Run the command again when ready.",
      );
    return {
      ...request,
      target: selected.kind,
      ...(selected.kind === "preview" ? { deployment: selected.name } : {}),
    };
  }
  if (request.action === "init" && interaction) {
    const info = readReply(
      initialization,
      await deps.client.command({
        action: "initialization-info",
        repoPath: request.repoPath,
        project: request.project,
      }),
    );
    assertActive(deps.signal);
    if (info.gitRequired && !request.createGit) {
      if (
        !(await interaction.confirm(
          "Rig needs Git. Initialize a repository in this directory?",
        ))
      )
        throw cancelled();
      request = { ...request, createGit: true };
    }
    if (!info.existing) {
      if (!request.project)
        request = {
          ...request,
          project: await interaction.text("Project name", info.name),
        };
      if (!request.productionBranch)
        request = {
          ...request,
          productionBranch: await interaction.text(
            "Production branch",
            info.productionBranch,
          ),
        };
    }
  }
  if (
    request.action === "deploy" &&
    request.target === "live" &&
    !request.branch
  ) {
    const info = readReply(
      deployment,
      await deps.client.command({
        action: "deployment-context",
        repoPath: request.repoPath,
        project: request.project,
      }),
    );
    assertActive(deps.signal);
    if (
      info.currentBranch !== null &&
      info.currentBranch !== info.productionBranch
    ) {
      if (!interaction)
        throw new RigError(
          "PRODUCTION_CONFIRMATION",
          `The current Branch differs from Production '${terminalText(info.productionBranch)}'.`,
          `Pass the Production Branch explicitly: rig deploy live ${terminalText(info.productionBranch)}.`,
        );
      if (
        !(await interaction.confirm(
          `Deploy Production branch '${terminalText(info.productionBranch)}' while the checkout is on '${terminalText(info.currentBranch)}'?`,
        ))
      )
        throw cancelled();
    }
    if (info.currentBranch === null)
      deps.output.error(
        `Detached HEAD: deploying Production branch '${terminalText(info.productionBranch)}'.\n`,
      );
    request = { ...request, branch: info.productionBranch };
  }
  assertActive(deps.signal);
  return request;
}
function cancelled(): RigError {
  return new RigError(
    "CANCELLED",
    "The operation was cancelled.",
    "No runtime change was requested.",
  );
}

function readReply<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new RigError(
      "DAEMON_PROTOCOL",
      "rigd returned an invalid interaction response.",
      "Check that rig and rigd use the same version.",
    );
  return result.data;
}

function assertActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelled();
}

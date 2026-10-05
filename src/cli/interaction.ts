import { z } from "zod";
import { terminalText } from "./terminal-text";
import { RigError, cancelled } from "../domain/errors";
import { shellWord } from "../domain/target-selector";
import type { RuntimeCommand } from "../daemon/protocol";
import type { CliDependencies } from "./types";
export interface CliInteraction {
  text(message: string, defaultValue: string): Promise<string>;
  confirm(message: string): Promise<boolean>;
}
const initialization = z.object({
  name: z.string(),
  productionBranch: z.string(),
  currentBranch: z.string().optional(),
  gitRequired: z.boolean(),
  existing: z.boolean(),
});
const deployment = z.object({
  project: z.string(),
  repoPath: z.string(),
  productionBranch: z.string(),
  currentBranch: z.string().nullable(),
  // Required: a reply without it would let a stable deploy skip its Production confirmation.
  selected: z.enum(["working", "stable", "preview"]),
});
/** Resolve human choices through read-only daemon queries before submitting any mutation. A command that names no Target
 * has its default from the grammar (working, or stable for a deploy), so no Target is ever chosen here. */
export async function prepareInteractiveRequest(
  request: RuntimeCommand,
  deps: Pick<CliDependencies, "signal" | "interaction" | "client" | "output">,
  options: { json?: boolean } = {},
): Promise<RuntimeCommand> {
  assertActive(deps.signal);
  const interaction = deps.interaction;
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
            info.currentBranch && info.currentBranch !== info.productionBranch
              ? `Production branch (the checkout is on '${terminalText(info.currentBranch)}')`
              : "Production branch",
            info.productionBranch,
          ),
        };
    }
  }
  if (request.action === "deploy") {
    const info = readReply(
      deployment,
      await deps.client.command({
        action: "deployment-context",
        repoPath: request.repoPath,
        project: request.project,
        ...(request.target ? { target: request.target } : {}),
      }),
    );
    assertActive(deps.signal);
    // A deploy resolved from the working directory must be visible before it acts, not only in its final line; structured callers get only the result.
    const branch =
      request.branch ??
      (info.selected === "stable" ? info.productionBranch : info.currentBranch);
    if (!options.json)
      deps.output.error(
        `Deploying ${terminalText(info.project)} (${terminalText(info.repoPath)}) to ${terminalText(
          request.deployment ?? request.target ?? "preview",
        )} from ${branch === null ? "a detached HEAD" : terminalText(branch)}.\n`,
      );
    if (info.selected !== "stable" || request.branch) return request;
    if (
      info.currentBranch !== null &&
      info.currentBranch !== info.productionBranch
    ) {
      if (!interaction)
        throw new RigError(
          "PRODUCTION_CONFIRMATION",
          `The current Branch differs from Production '${terminalText(info.productionBranch)}'.`,
          `Pass the Production Branch explicitly: rig deploy stable ${shellWord(terminalText(info.productionBranch))}.`,
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

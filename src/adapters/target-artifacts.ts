import { resolve } from "node:path";
import type { InstalledComponent, TargetPlan } from "../config/types";
import { installedPath } from "../domain/installed-path";
import { isGitCommit } from "../domain/git";
import { RigError } from "../domain/errors";
import type { TargetRecord } from "../domain/runtime";
import type { CommandRunner } from "../providers/contracts";
import {
  isSourceEntrypoint,
  shimRunsFrom,
  type ArtifactInstaller,
} from "../providers/artifact-installer";
import { removeFileDurably } from "../providers/private-files";
import type {
  ArtifactIdentity,
  RepositoryIdentity,
  createArtifactOwnership,
} from "./artifact-ownership";
import type { createEffectTransactions } from "./effect-transactions";
import type { FileDigest } from "./file-digest";
import {
  installationPolicyKey,
  installedSourceRevision,
  readInstallReceipt,
  receiptPath,
} from "./install-receipts";
import { exists } from "./path-exists";

export type ArtifactOwnership = ReturnType<typeof createArtifactOwnership>;
export type EffectTransactions = ReturnType<typeof createEffectTransactions>;
/** A Target's published Tools: who publishes each, and their retirement and observation. Publication itself is
 * `createToolPublication`'s. */
export interface TargetArtifacts {
  /** Who publishes `component` of `target`, as ownership records it. */
  identity(
    target: TargetRecord,
    component: InstalledComponent,
  ): ArtifactIdentity;
  /** Where the publication receipt of `component` of `target` is kept. */
  receipt(target: TargetRecord, component: InstalledComponent): string;
  /** Every Tool `target` publishes and, with `previous`, every one of `previous` it retires, as an effect checkpoint
   * records them. */
  checkpointed(
    target: TargetRecord,
    previous?: TargetRecord,
  ): Promise<(ArtifactIdentity & { receiptPath: string })[]>;
  /** Removes every Tool of `target` that is its own to remove, with its receipt. */
  retireArtifacts(target: TargetRecord): Promise<void>;
  /** Removes the Tools only `previous` names that are its to retire. */
  retireSuperseded(
    previous: TargetRecord,
    candidate: TargetRecord,
  ): Promise<void>;
  /** Whether `component` of `target` is published as its receipt says, read now; unknown when that cannot be told. */
  observe(
    target: TargetRecord,
    component: InstalledComponent,
  ): Promise<"installed" | "missing" | "unknown">;
  /** Whether a Tool of `target` is a shim whose source lies in `checkout`. */
  toolRunsFrom(target: TargetRecord, checkout: string): Promise<boolean>;
}
/** The Tools of Targets under `root`, owned through `ownership`, changed through `transactions`, and observed through
 * `installer` and `digestFile`. `run` asks git, with `environment`, for the repository identity of the Project's
 * registered repository, which `projectRepository` reads from state. */
export function createTargetArtifacts(options: {
  root: string;
  run: CommandRunner;
  environment: Readonly<Record<string, string>>;
  installer: ArtifactInstaller;
  digestFile: FileDigest;
  ownership: ArtifactOwnership;
  transactions: EffectTransactions;
  projectRepository?: (projectId: string) => Promise<string | undefined>;
}): TargetArtifacts {
  const { ownership, transactions } = options;
  const receipt = (target: TargetRecord, component: InstalledComponent) =>
    receiptPath(options.root, target.id, component.name);
  /** The identity of the repository `target` was deployed from: the root commits of its Commit (the Working copy's HEAD
   * when it has none), read in the Project's own registered repository, sorted and joined by commas: the same in every full
   * clone, whatever its remotes. Never read from Rig's mirror or a checkout, whose history Rig fetched piecemeal. A shallow
   * Project repository is `shallow`: git reports where its history was cut as roots, which match nothing. Unknown when
   * git cannot say: no registered repository, the Commit not in it, no git. Never fetches anything. */
  const repositoryIdentity = async (
    target: TargetRecord,
  ): Promise<RepositoryIdentity> => {
    try {
      const repository = await options.projectRepository?.(target.projectId);
      if (repository === undefined) return { kind: "unknown" };
      if (target.commit !== undefined && !isGitCommit(target.commit))
        return { kind: "unknown" };
      const git = async (args: string[]) => {
        const result = await options.run({
          command: ["git", ...args],
          cwd: repository,
          env: options.environment,
          timeoutMs: 30_000,
        });
        return result.exitCode === 0 ? result.stdout : undefined;
      };
      const shallow = (
        await git(["rev-parse", "--is-shallow-repository"])
      )?.trim();
      if (shallow === "true") return { kind: "shallow" };
      if (shallow !== "false") return { kind: "unknown" };
      return rootCommits(
        (await git(["rev-list", "--max-parents=0", target.commit ?? "HEAD"])) ??
          "",
      );
    } catch {
      return { kind: "unknown" };
    }
  };
  const identity = (target: TargetRecord, component: InstalledComponent) => ({
    targetId: target.id,
    componentName: component.name,
    destination: installedPath(options.root, target, component),
    project: target.plan.project,
    target: target.name,
    repository: () => repositoryIdentity(target),
  });
  /** The Tools only `previous` names that are its to retire. One another Target owns, or a file Rig did not install, was
   * never published by it: a working Target records its plan before a start is refused for such a Tool, and dropping the
   * Tool from rig.yaml leaves that file as it is. An executable it did publish is still held to every other check. */
  const retirable = async (previous: TargetRecord, candidate: TargetRecord) => {
    const own: InstalledComponent[] = [];
    for (const component of supersededTools(options.root, previous, candidate))
      try {
        await ownership.inspect(identity(previous, component));
        own.push(component);
      } catch (error) {
        if (
          !(error instanceof RigError) ||
          !["ARTIFACT_CONFLICT", "ARTIFACT_UNOWNED"].includes(error.code)
        )
          throw error;
      }
    return own;
  };
  const retire = async (
    target: TargetRecord,
    components: readonly InstalledComponent[],
  ) => {
    for (const component of components) {
      if (component.kind !== "installed") continue;
      const owner = identity(target, component),
        destination = owner.destination,
        receiptFile = receipt(target, component);
      const owned = await ownership.inspect(owner);
      // A released executable (its owner Target is gone) is not this Target's to retire: it stays, as a forget leaves it.
      const retired = owned.released
        ? [receiptFile]
        : [destination, ...ownership.ownedPaths(destination), receiptFile];
      // Only what it removes is journalled as changing, so a recovery never takes a released Tool for its own work.
      await transactions.withArtifactChange(target.id, retired, async () => {
        for (const path of retired) await removeFileDurably(path);
      });
    }
  };
  return {
    identity,
    receipt,
    async checkpointed(target, previous) {
      return [
        ...installedTools(target.plan).map((component) => ({
          target,
          component,
        })),
        ...(previous
          ? (await retirable(previous, target)).map((component) => ({
              target: previous,
              component,
            }))
          : []),
      ].map(({ target: owner, component }) => ({
        ...identity(owner, component),
        receiptPath: receipt(owner, component),
      }));
    },
    retireArtifacts: (target) => retire(target, installedTools(target.plan)),
    retireSuperseded: async (previous, candidate) =>
      await retire(previous, await retirable(previous, candidate)),
    async observe(target, component) {
      try {
        if (
          isSourceEntrypoint(component.entrypoint) &&
          !(await exists(
            resolve(target.plan.workspacePath, component.entrypoint),
          ))
        )
          return "missing";
        const destination = installedPath(options.root, target, component);
        const owned = await ownership.inspect({
          targetId: target.id,
          componentName: component.name,
          destination,
          project: target.plan.project,
          target: target.name,
        });
        if (owned.revision === undefined) return "missing";
        if (!owned.owner) return "unknown";
        const saved = await readInstallReceipt(receipt(target, component));
        const key = installationPolicyKey(
          target.plan.workspacePath,
          component,
          destination,
        );
        if (
          !saved ||
          saved.key !== key ||
          saved.installedRevision !== owned.revision ||
          saved.sourceRevision !==
            (await installedSourceRevision(
              resolve(target.plan.workspacePath, component.entrypoint),
              options.digestFile,
              options.installer,
            ))
        )
          return "unknown";
        return await options.installer.observe(destination);
      } catch {
        return "unknown";
      }
    },
    async toolRunsFrom(target, checkout) {
      for (const component of installedTools(target.plan))
        if (
          await shimRunsFrom(
            installedPath(options.root, target, component),
            checkout,
          )
        )
          return true;
      return false;
    },
  };
}
/** The Tools a plan publishes. */
export function installedTools(plan: TargetPlan): InstalledComponent[] {
  return plan.components.filter(
    (component): component is InstalledComponent =>
      component.kind === "installed",
  );
}
/** The Tools `previous` publishes under `root` at a path `candidate` does not publish. */
export function supersededTools(
  root: string,
  previous: TargetRecord,
  candidate: TargetRecord,
): InstalledComponent[] {
  const retained = new Set(
    installedTools(candidate.plan).map((component) =>
      installedPath(root, candidate, component),
    ),
  );
  return installedTools(previous.plan).filter(
    (component) => !retained.has(installedPath(root, previous, component)),
  );
}
/** A repository's identity from what `git rev-list --max-parents=0` printed: its root commits, sorted and joined by
 * commas; unknown when it printed none. */
export function rootCommits(printed: string): RepositoryIdentity {
  const roots = printed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{40,64}$/.test(line))
    .sort();
  return roots.length
    ? { kind: "known", roots: roots.join(",") }
    : { kind: "unknown" };
}

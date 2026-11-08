import { resolve } from "node:path";
import type { InstalledComponent } from "../config/types";
import type { TargetRecord } from "../domain/runtime";
import type { ArtifactInstaller } from "../providers/artifact-installer";
import type { FileDigest } from "./file-digest";
import {
  installationPolicyKey,
  installedSourceRevision,
  readInstallReceipt,
  writeInstallReceipt,
} from "./install-receipts";
import type { InvocationEnvironment } from "./invocation-environment";
import type {
  ArtifactOwnership,
  EffectTransactions,
  TargetArtifacts,
} from "./target-artifacts";

/** Publishes a Tool's executable; never builds. */
export type ToolPublication = (
  component: InstalledComponent,
  target: TargetRecord,
) => Promise<{ outcome: "installed" | "unchanged" }>;
/** Tool publication under `root` through `installer`, in the Tool's environment from `environment`. A Tool whose receipt
 * says it is published from the same policy and source, and whose executable is the one published, is left unchanged;
 * any other is published again with its ownership records and receipt, as one artifact change of its Target. */
export function createToolPublication(options: {
  root: string;
  installer: ArtifactInstaller;
  digestFile: FileDigest;
  ownership: ArtifactOwnership;
  transactions: EffectTransactions;
  artifacts: Pick<TargetArtifacts, "identity" | "receipt">;
  environment: Pick<InvocationEnvironment, "environment">;
}): ToolPublication {
  const { ownership, transactions, installer, digestFile } = options;
  return async (component, target) => {
    const identity = options.artifacts.identity(target, component),
      destination = identity.destination,
      source = resolve(target.plan.workspacePath, component.entrypoint);
    await ownership.inspect(identity);
    const env = await options.environment.environment(target, component);
    const key = installationPolicyKey(
      target.plan.workspacePath,
      component,
      destination,
    );
    const receiptFile = options.artifacts.receipt(target, component);
    const receipt = await readInstallReceipt(receiptFile);
    const published =
      receipt?.key === key &&
      (await installer.observe(destination)) === "installed" &&
      (await digestFile(destination)) === receipt.installedRevision;
    const unchanged = async () =>
      published &&
      (await installedSourceRevision(source, digestFile, installer)) ===
        receipt!.sourceRevision;
    if (await unchanged()) {
      // Rig's own executable published before its provenance was recorded gets it now, so a later forget can hand it on.
      const owned = ownership.ownedPaths(destination).slice(1);
      if (owned.length)
        await transactions.withArtifactChange(target.id, owned, () =>
          ownership.backfillProvenance(identity),
        );
      return { outcome: "unchanged" };
    }
    await transactions.withArtifactChange(
      target.id,
      [destination, ...ownership.ownedPaths(destination), receiptFile],
      async () => {
        await ownership.publish(identity, async () => {
          await installer.install({
            cwd: target.plan.workspacePath,
            entrypoint: component.entrypoint,
            destination,
            env,
          });
        });
        await writeInstallReceipt(options.root, receiptFile, {
          key,
          sourceRevision: (await installedSourceRevision(
            source,
            digestFile,
            installer,
          ))!,
          installedRevision: (await digestFile(destination))!,
        });
      },
    );
    return { outcome: "installed" };
  };
}

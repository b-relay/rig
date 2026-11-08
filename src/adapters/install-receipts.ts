import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { InstalledComponent } from "../config/types";
import { RigError } from "../domain/errors";
import type { ArtifactInstaller } from "../providers/artifact-installer";
import { replacePrivateFile } from "../providers/private-files";
import type { FileDigest } from "./file-digest";
import { exists } from "./path-exists";

const installReceiptSchema = z.object({
  key: z.string().describe("Digest of recorded installation policy."),
  sourceRevision: z.string().describe("Installed source identity."),
  installedRevision: z.string().describe("Digest of the published artifact."),
});
/** What a Tool's publication recorded: the policy it was published under, its source and the published artifact. */
export type InstallReceipt = z.infer<typeof installReceiptSchema>;

/** `<root>/installed/<digest>.json`: the publication receipt of `componentName` of Target `targetId`. */
export function receiptPath(
  root: string,
  targetId: string,
  componentName: string,
): string {
  return join(
    root,
    "installed",
    createHash("sha256").update(`${targetId}:${componentName}`).digest("hex") +
      ".json",
  );
}
/** Undefined when no receipt was written; a corrupt one fails INSTALL_RECEIPT. */
export async function readInstallReceipt(
  path: string,
): Promise<InstallReceipt | undefined> {
  const raw = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (raw === undefined) return undefined;
  try {
    return installReceiptSchema.parse(JSON.parse(raw));
  } catch {
    throw new RigError(
      "INSTALL_RECEIPT",
      "An installed component receipt is corrupt.",
      "Inspect the installation state before retrying.",
      { path },
    );
  }
}
export async function writeInstallReceipt(
  root: string,
  path: string,
  receipt: InstallReceipt,
): Promise<void> {
  // On disk before the journal captures it as this change's own.
  await replacePrivateFile(root, path, JSON.stringify(receipt), {
    durable: true,
  });
}
/** Keys a publication receipt on the public policy the Project declares: its public env and which env files it names, never their contents,
 * so a secret never reaches a receipt and a changed operator file does not republish a Tool. The baseline (PATH, HOME, ...) is
 * excluded too, so a daemon restarted from another shell does not republish every installed Component. */
export function installationPolicyKey(
  workspace: string,
  component: Pick<InstalledComponent, "entrypoint" | "env" | "envFiles">,
  destination: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspace,
        entrypoint: component.entrypoint,
        destination,
        env: component.env,
        envFiles: (component.envFiles ?? []).map((file) => file.path),
      }),
    )
    .digest("hex");
}
/** The receipt's view of the source: the file's digest when it is copied, or the installer's shim revision when it is shimmed,
 * since a shim reads the file at run time and changes only with its interpreter. Undefined when the source is missing. */
export async function installedSourceRevision(
  source: string,
  digestFile: FileDigest,
  installer: ArtifactInstaller,
): Promise<string | undefined> {
  const shim = installer.shimRevision(source);
  if (shim === undefined) return await digestFile(source);
  return (await exists(source)) ? shim : undefined;
}

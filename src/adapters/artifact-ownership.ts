import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  mkdir,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { RigError } from "../domain/errors";
const ownerSchema = z
  .object({
    targetId: z.string().describe("Stable Target that owns this executable."),
    componentName: z.string().describe("Owning Component name."),
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe("SHA-256 of the last executable published by the owner."),
  })
  .strict();
export type ArtifactOwner = z.infer<typeof ownerSchema>;
export interface ArtifactIdentity {
  targetId: string;
  componentName: string;
  destination: string;
}
/** One daemon serializes ownership mutations; existing unowned files require explicit migration. */
export function createArtifactOwnership(root: string) {
  const ownerPath = (destination: string) =>
    join(
      root,
      "installed",
      "owners",
      createHash("sha256").update(destination).digest("hex") + ".json",
    );
  const owner = async (
    destination: string,
  ): Promise<ArtifactOwner | undefined> => {
    const raw = await optionalFile(ownerPath(destination));
    if (raw === undefined) return undefined;
    try {
      return ownerSchema.parse(JSON.parse(raw.toString()));
    } catch {
      throw new RigError(
        "ARTIFACT_OWNER",
        "An executable ownership record is invalid.",
        "Inspect installed ownership state before retrying.",
      );
    }
  };
  const inspect = async (identity: ArtifactIdentity) => {
    const saved = await owner(identity.destination),
      revision = await artifactRevision(identity.destination);
    if (
      saved &&
      (saved.targetId !== identity.targetId ||
        saved.componentName !== identity.componentName)
    )
      throw new RigError(
        "ARTIFACT_CONFLICT",
        "Another Component owns this installed executable.",
        "Choose a different installName.",
        { destination: identity.destination },
      );
    if (!saved && revision !== undefined)
      throw new RigError(
        "ARTIFACT_UNOWNED",
        "An unmanaged executable already occupies this installation path.",
        "Preserve or explicitly adopt the existing executable before installing.",
        { destination: identity.destination },
      );
    if (saved && revision !== undefined && saved.revision !== revision)
      throw new RigError(
        "ARTIFACT_CHANGED",
        "The installed executable changed outside its owning Component.",
        "Inspect and preserve that change before reinstalling.",
        { destination: identity.destination },
      );
    return { owner: saved, revision };
  };
  return {
    inspect,
    owner,
    ownerPath,
    async publish(identity: ArtifactIdentity, write: () => Promise<void>) {
      await inspect(identity);
      await write();
      const revision = await artifactRevision(identity.destination);
      if (!revision)
        throw new RigError(
          "ARTIFACT_MISSING",
          "The installer did not publish an executable.",
          "Inspect the Component installation.",
        );
      await atomicFile(
        ownerPath(identity.destination),
        JSON.stringify({
          targetId: identity.targetId,
          componentName: identity.componentName,
          revision,
        }),
      );
    },
  };
}
/** Explicit migration only: the caller must verify the backed-up bytes it intends to adopt. */
export async function adoptInstalledArtifact(
  root: string,
  identity: ArtifactIdentity,
  expectedRevision: string,
): Promise<void> {
  const ownership = createArtifactOwnership(root);
  const saved = await ownership.owner(identity.destination);
  if (
    saved &&
    (saved.targetId !== identity.targetId ||
      saved.componentName !== identity.componentName)
  )
    throw new RigError(
      "ARTIFACT_CONFLICT",
      "The executable already has a different owner.",
      "Resolve its ownership before adoption.",
    );
  const revision = await artifactRevision(identity.destination);
  if (revision !== expectedRevision)
    throw new RigError(
      "ARTIFACT_CHANGED",
      "The executable differs from the approved adoption bytes.",
      "Recheck and back up the current executable before adoption.",
    );
  await atomicFile(
    ownership.ownerPath(identity.destination),
    JSON.stringify({
      targetId: identity.targetId,
      componentName: identity.componentName,
      revision,
    }),
  );
}
export async function artifactRevision(
  path: string,
): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile())
    throw new RigError(
      "ARTIFACT_TYPE",
      "An installation path is not a regular file.",
      "Preserve the existing path and choose another installation name.",
      { path },
    );
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
export async function optionalFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function atomicFile(
  path: string,
  bytes: string | Buffer,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, bytes, { mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

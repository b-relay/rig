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
    project: z
      .string()
      .optional()
      .describe("Owning Project name, so a conflict can name it."),
    target: z
      .string()
      .optional()
      .describe("Owning Target name, so a conflict can name it."),
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
  /** The owning Project and Target names, recorded so a later conflict can name them. */
  project?: string;
  target?: string;
}
/** One daemon serializes ownership mutations; an existing unowned file is never taken over. */
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
    // A Target may hand its own executable to a renamed Component; only another Target is refused.
    if (saved && saved.targetId !== identity.targetId)
      throw new RigError(
        "ARTIFACT_CONFLICT",
        `${
          saved.project && saved.target
            ? `Project '${saved.project}' Target '${saved.target}' Component '${saved.componentName}'`
            : `Another Target's Component '${saved.componentName}'`
        } owns the installed executable ${identity.destination}.`,
        "Give this Component a different installName; installed executables share one bin directory across Projects and Targets.",
        {
          destination: identity.destination,
          owner: {
            targetId: saved.targetId,
            componentName: saved.componentName,
            ...(saved.project ? { project: saved.project } : {}),
            ...(saved.target ? { target: saved.target } : {}),
          },
        },
      );
    if (!saved && revision !== undefined)
      throw new RigError(
        "ARTIFACT_UNOWNED",
        `An executable Rig did not install already occupies ${identity.destination}.`,
        "Move or delete it, then retry; Rig never overwrites an executable it did not install.",
        { destination: identity.destination },
      );
    if (saved && revision !== undefined && saved.revision !== revision)
      throw new RigError(
        "ARTIFACT_CHANGED",
        `The installed executable ${identity.destination} changed outside its owning Component ${saved.componentName}.`,
        `Move or delete ${identity.destination} to keep or discard that change, then retry.`,
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
          ...(identity.project ? { project: identity.project } : {}),
          ...(identity.target ? { target: identity.target } : {}),
          revision,
        }),
      );
    },
  };
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

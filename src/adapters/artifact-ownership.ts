import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { RigError } from "../domain/errors";
import { fileDigest, type FileDigest } from "./file-digest";
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
/** The owner as a message names it: its Project, Target and Component when recorded, else its Component alone. */
export function describeOwner(owner: ArtifactOwner): string {
  return owner.project && owner.target
    ? `Project '${owner.project}' Target '${owner.target}' Component '${owner.componentName}'`
    : `Another Target's Component '${owner.componentName}'`;
}
/** The owner as error details carry it: every recorded identity field, never the revision. */
export function ownerDetails(owner: ArtifactOwner) {
  return {
    targetId: owner.targetId,
    componentName: owner.componentName,
    ...(owner.project ? { project: owner.project } : {}),
    ...(owner.target ? { target: owner.target } : {}),
  };
}
export interface ArtifactIdentity {
  targetId: string;
  componentName: string;
  destination: string;
  /** The owning Project and Target names, recorded so a later conflict can name them. */
  project?: string;
  target?: string;
}
/** One daemon serializes ownership mutations; an existing unowned file is never taken over.
 * `digest` hashes an executable; the daemon passes a remembering one so status calls do not
 * re-read every Tool. */
export function createArtifactOwnership(
  root: string,
  digest: FileDigest = fileDigest,
) {
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
      current = await digest(identity.destination);
    // A Target may hand its own executable to a renamed Component; only another Target is refused.
    if (saved && saved.targetId !== identity.targetId)
      throw new RigError(
        "ARTIFACT_CONFLICT",
        `${describeOwner(saved)} owns the installed executable ${identity.destination}.`,
        "Rename one of the Tools in its rig.yaml; installed executables share one bin directory across Projects and Targets.",
        { destination: identity.destination, owner: ownerDetails(saved) },
      );
    if (!saved && current !== undefined)
      throw new RigError(
        "ARTIFACT_UNOWNED",
        `An executable Rig did not install already occupies ${identity.destination}.`,
        "Move or delete it, then retry; Rig never overwrites an executable it did not install.",
        { destination: identity.destination },
      );
    if (saved && current !== undefined && saved.revision !== current)
      throw new RigError(
        "ARTIFACT_CHANGED",
        `The installed executable ${identity.destination} changed outside its owning Component ${saved.componentName}.`,
        `Move or delete ${identity.destination} to keep or discard that change, then retry.`,
        { destination: identity.destination },
      );
    return { owner: saved, revision: current };
  };
  // The bin directory is shared by every Project; Targets run side by side, so one destination is published at a time and a
  // second claimant sees the first one's ownership record instead of overwriting its executable.
  const publishing = new Map<string, Promise<void>>();
  const oneAtATime = (destination: string, change: () => Promise<void>) => {
    const next = (publishing.get(destination) ?? Promise.resolve())
      .catch(() => {})
      .then(change);
    publishing.set(destination, next);
    void next
      .finally(() => {
        if (publishing.get(destination) === next)
          publishing.delete(destination);
      })
      .catch(() => {});
    return next;
  };
  return {
    inspect,
    owner,
    ownerPath,
    publish: (identity: ArtifactIdentity, write: () => Promise<void>) =>
      oneAtATime(identity.destination, async () => {
        await inspect(identity);
        await write();
        const published = await digest(identity.destination);
        if (!published)
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
            revision: published,
          }),
        );
      }),
  };
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

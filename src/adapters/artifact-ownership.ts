import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  readdir,
  mkdir,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
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
/** An installed executable whose ownership record names a Target no state record names (one a `rig forget` left, #343, or a
 * state that lost its Target). */
export interface OrphanedArtifact {
  destination: string;
  owner: ArtifactOwner;
  /** Its bytes are no longer the ones Rig published for that owner: Rig never replaces or removes it. */
  changed: boolean;
}
/** One daemon serializes ownership mutations; an existing unowned file is never taken over.
 * `digest` hashes an executable; the daemon passes a remembering one so status calls do not
 * re-read every Tool. `recordedTargets` reads the Target ids state records now: an executable whose owner it does not name
 * is released, and the next Target that publishes there takes it over while its bytes are still the ones Rig published.
 * Absent, every owner counts as recorded and nothing is taken over. */
export function createArtifactOwnership(
  root: string,
  digest: FileDigest = fileDigest,
  recordedTargets?: () => Promise<ReadonlySet<string>>,
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
  /** Whether `saved` names a Target state no longer records. Read only when another Target asks for its path, after the
   * record: every Target is recorded before it publishes a Tool, so one being created is never taken for released. */
  const released = async (saved: ArtifactOwner) =>
    recordedTargets !== undefined &&
    !(await recordedTargets()).has(saved.targetId);
  /** Rig's own executables: rigd's system job runs `<root>/bin/rigd`, and `rig` drives it. Released, they go only to a
   * Target of the Project that published them, so no other Project's Tool of that name becomes the daemon launchd starts. */
  const rigItself = new Set([
    join(root, "bin", "rig"),
    join(root, "bin", "rigd"),
  ]);
  /** Who may publish at `identity.destination` now. Resolves with its recorded owner and current digest; `released` is set,
   * and `owner` left out, when the owner is a Target state no longer records and the bytes are still the ones Rig published
   * for it (or gone), so `identity` takes it over. Rejects ARTIFACT_CONFLICT for another recorded owner (and for a released
   * `bin/rig` or `bin/rigd` asked for by another Project than the one that published it), ARTIFACT_UNOWNED
   * for a file Rig did not install, ARTIFACT_CHANGED for bytes that differ from the recorded revision, released or not. */
  const inspect = async (
    identity: ArtifactIdentity,
  ): Promise<{
    owner: ArtifactOwner | undefined;
    revision: string | undefined;
    released?: ArtifactOwner;
  }> => {
    const saved = await owner(identity.destination),
      current = await digest(identity.destination);
    if (
      saved &&
      saved.targetId !== identity.targetId &&
      (await released(saved))
    ) {
      // Rig never replaces bytes it did not publish, whoever owned them.
      if (current !== undefined && current !== saved.revision)
        throw new RigError(
          "ARTIFACT_CHANGED",
          `The installed executable ${identity.destination} changed since Rig published it for ${describeOwner(saved)}, whose Target no longer exists.`,
          `Rig never replaces or removes an executable that changed. Move or delete ${identity.destination} to keep or discard that change, then retry.`,
          {
            destination: identity.destination,
            owner: ownerDetails(saved),
            released: true,
          },
        );
      if (
        rigItself.has(identity.destination) &&
        (saved.project === undefined || saved.project !== identity.project)
      )
        throw new RigError(
          "ARTIFACT_CONFLICT",
          `${identity.destination} is Rig itself, published by ${describeOwner(saved)}, whose Target no longer exists; only a Target of ${saved.project ? `Project '${saved.project}'` : "the Project that published it"} takes it over.`,
          `Rename the Tool in its rig.yaml; rigd's system job runs ${join(root, "bin", "rigd")}, so no other Project's Tool replaces it. Register Rig's own repository again and deploy its stable Target to publish it again.`,
          {
            destination: identity.destination,
            owner: ownerDetails(saved),
            released: true,
          },
        );
      return { owner: undefined, revision: current, released: saved };
    }
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
  /** Every executable in `<root>/bin` whose ownership record names a Target `recorded` does not, with whether its bytes
   * changed since. The records are read before `recorded`, so a Target recorded meanwhile is never reported. Executables
   * without a record, with an unreadable one, or gone by the time they are hashed are left out. */
  const orphans = async (
    recorded: () => Promise<ReadonlySet<string>>,
  ): Promise<OrphanedArtifact[]> => {
    const bin = join(root, "bin");
    let names: string[];
    try {
      names = await readdir(bin);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const owned: { destination: string; owner: ArtifactOwner }[] = [];
    for (const name of names.sort()) {
      const destination = join(bin, name);
      const saved = await owner(destination).catch(() => undefined);
      if (saved) owned.push({ destination, owner: saved });
    }
    const targets = await recorded();
    const found: OrphanedArtifact[] = [];
    for (const entry of owned) {
      if (targets.has(entry.owner.targetId)) continue;
      const current = await digest(entry.destination).catch(() => undefined);
      if (current === undefined) continue;
      found.push({ ...entry, changed: current !== entry.owner.revision });
    }
    return found;
  };
  return {
    inspect,
    orphans,
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

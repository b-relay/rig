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
/** Which repository published Rig's own executables (`bin/rig`, `bin/rigd`), kept beside their ownership record rather than
 * in it, so an older rigd, which reads that record strictly, still reads it. Bound to the owner and bytes it was written
 * for: one that names another Target or revision says nothing. */
const provenanceSchema = z
  .object({
    targetId: z.string().describe("Target whose publication this describes."),
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe("SHA-256 of the executable that Target published."),
    repository: z
      .string()
      .min(1)
      .describe(
        "The publishing repository's identity: its root commits, sorted and joined by commas, the same in every clone.",
      ),
  })
  .strict();
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
/** What git says about the repository a checkout comes from: its identity (its root commits, sorted and joined by commas,
 * the same in every full clone), or that it is a shallow clone, whose oldest commits are only where its history was cut and
 * so prove nothing, or that git could not say. */
export type RepositoryIdentity =
  | { readonly kind: "known"; readonly roots: string }
  | { readonly kind: "shallow" }
  | { readonly kind: "unknown" };
const unknownRepository: RepositoryIdentity = { kind: "unknown" };
export interface ArtifactIdentity {
  targetId: string;
  componentName: string;
  destination: string;
  /** The owning Project and Target names, recorded so a later conflict can name them. */
  project?: string;
  target?: string;
  /** The identity of the repository the Target's workspace comes from. Asked only for Rig's own executables: recorded
   * when one is published (never a shallow one's), and compared before a released one is taken over. */
  repository?: () => Promise<RepositoryIdentity>;
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
  /** Beside the ownership record of Rig's own executables: which repository published them. */
  const provenancePath = (destination: string) =>
    ownerPath(destination).replace(/\.json$/, ".repository.json");
  /** Rig's own executables: rigd's system job runs `<root>/bin/rigd`, and `rig` drives it. Released, they go only to a
   * Target whose repository is the one that published them, so no other repository's Tool of that name becomes the daemon
   * launchd starts. */
  const rigItself = new Set([
    join(root, "bin", "rig"),
    join(root, "bin", "rigd"),
  ]);
  /** Every file a publication at `destination` writes besides the executable and its receipt: the ownership record, and for
   * Rig's own executables its provenance. An effect checkpoint covers all of them. */
  const ownedPaths = (destination: string) =>
    rigItself.has(destination)
      ? [ownerPath(destination), provenancePath(destination)]
      : [ownerPath(destination)];
  /** The repository that published `saved`'s bytes at `destination`, or undefined when none is recorded for that owner and
   * revision (published before provenance was recorded, unreadable, or written for another publication). */
  const provenance = async (destination: string, saved: ArtifactOwner) => {
    const raw = await optionalFile(provenancePath(destination)).catch(
      () => undefined,
    );
    if (raw === undefined) return undefined;
    try {
      const recorded = provenanceSchema.parse(JSON.parse(raw.toString()));
      return recorded.targetId === saved.targetId &&
        recorded.revision === saved.revision
        ? recorded.repository
        : undefined;
    } catch {
      return undefined;
    }
  };
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
  /** Who may publish at `identity.destination` now. Resolves with its recorded owner and current digest; `released` is set,
   * and `owner` left out, when the owner is a Target state no longer records and the bytes are still the ones Rig published
   * for it (or gone), so `identity` takes it over. Rejects ARTIFACT_CONFLICT for another recorded owner, and for a released
   * `bin/rig` or `bin/rigd` unless `identity`'s repository is the one recorded as publishing it (fails closed when either is
   * unknown); ARTIFACT_UNOWNED
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
      if (rigItself.has(identity.destination))
        await assertSameRepository(identity, saved);
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
  /** Refuses (ARTIFACT_CONFLICT) to hand Rig's own released executable at `identity.destination` to `identity` unless the
   * repository recorded as publishing `saved`'s bytes is `identity`'s, both known. A Project name proves nothing: any
   * repository may call itself `rig`, and launchd starts whatever `bin/rigd` holds. */
  const assertSameRepository = async (
    identity: ArtifactIdentity,
    saved: ArtifactOwner,
  ) => {
    const daemon = join(root, "bin", "rigd");
    const details = {
      destination: identity.destination,
      owner: ownerDetails(saved),
      released: true,
    };
    const published = await provenance(identity.destination, saved);
    if (published === undefined)
      throw new RigError(
        "ARTIFACT_CONFLICT",
        `${identity.destination} is Rig itself, published by ${describeOwner(saved)}, whose Target no longer exists, before Rig recorded which repository publishes it; Rig hands it to no new registration.`,
        `Keep it: rigd's system job runs ${daemon}. Rename this Tool in its rig.yaml if it is not Rig. To upgrade Rig on this Host, follow the manual steps in the rig:rigd skill's upgrade reference (a new file renamed over the old one, never a copy in place).`,
        { ...details, reason: "provenance-missing" },
      );
    const claimant = await repositoryOf(identity);
    if (claimant.kind === "shallow")
      throw new RigError(
        "ARTIFACT_CONFLICT",
        `${identity.destination} is Rig itself, published by ${describeOwner(saved)}, whose Target no longer exists. This checkout is a shallow clone, so its history can't be matched with the repository that published it.`,
        `Keep it: rigd's system job runs ${daemon}. Run git fetch --unshallow in the Project's repository, then deploy again.`,
        { ...details, reason: "repository-shallow" },
      );
    if (claimant.kind === "unknown" || claimant.roots !== published)
      throw new RigError(
        "ARTIFACT_CONFLICT",
        `${identity.destination} is Rig itself, published by ${describeOwner(saved)} from another repository${claimant.kind === "unknown" ? " (this Target's repository could not be identified)" : ""}; only that repository registered again takes it over.`,
        `Keep it: rigd's system job runs ${daemon}. Rename this Tool in its rig.yaml if it is not Rig; otherwise register the repository that published it (any clone of it) and run rig deploy stable for it.`,
        {
          ...details,
          reason:
            claimant.kind === "unknown"
              ? "repository-unknown"
              : "repository-different",
        },
      );
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
  /** `identity`'s repository; unknown when it names none or asking fails. */
  const repositoryOf = async (
    identity: ArtifactIdentity,
  ): Promise<RepositoryIdentity> =>
    (await identity.repository?.().catch(() => unknownRepository)) ??
    unknownRepository;
  /** Records which repository published Rig's own executable at `identity.destination` as `revision`, when it is known
   * (never from a shallow clone, whose roots prove nothing); otherwise removes a record that would describe an earlier
   * publication. Nothing for any other Tool. */
  const recordProvenance = async (
    identity: ArtifactIdentity,
    revision: string,
    repository: RepositoryIdentity,
  ) => {
    if (!rigItself.has(identity.destination)) return;
    const path = provenancePath(identity.destination);
    if (repository.kind !== "known") await rm(path, { force: true });
    else
      await atomicFile(
        path,
        JSON.stringify({
          targetId: identity.targetId,
          revision,
          repository: repository.roots,
        }),
      );
  };
  return {
    inspect,
    orphans,
    owner,
    ownerPath,
    ownedPaths,
    /** Records the provenance of Rig's own executable that `identity` owns and published unchanged, when none is recorded
     * for it yet (an executable published before provenance was): written on the next start or deploy that finds it current.
     * Nothing for any other Tool, or when its owner is not `identity`'s Target. */
    async backfillProvenance(identity: ArtifactIdentity) {
      if (!rigItself.has(identity.destination)) return;
      await oneAtATime(identity.destination, async () => {
        const saved = await owner(identity.destination);
        if (saved?.targetId !== identity.targetId) return;
        if ((await provenance(identity.destination, saved)) !== undefined)
          return;
        const repository = await repositoryOf(identity);
        if (repository.kind === "known")
          await recordProvenance(identity, saved.revision, repository);
      });
    },
    publish: (identity: ArtifactIdentity, write: () => Promise<void>) =>
      oneAtATime(identity.destination, async () => {
        await inspect(identity);
        // Asked before the write, so nothing slow runs between the executable and its records.
        const repository = rigItself.has(identity.destination)
          ? await repositoryOf(identity)
          : unknownRepository;
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
        await recordProvenance(identity, published, repository);
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

import { createHash, randomUUID } from "node:crypto";
import {
  access,
  readFile,
  writeFile,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { RigError } from "../domain/errors";
const text = z.string().min(1),
  revisionSchema = z.string().regex(/^[a-f0-9]{64}$/),
  timestamp = z.string().datetime({ offset: true });
const pendingProcess = z
  .object({
    project: text,
    target: text,
    component: text,
    key: text,
    provider: text,
    legacyLabel: text.optional(),
    status: z.literal("requires-adoption"),
    reason: text,
  })
  .strict();
const pendingRoute = z
  .object({
    project: text,
    target: text,
    component: text,
    key: text,
    legacyMarker: text,
    hostname: text,
    upstream: text,
    status: z.literal("requires-adoption"),
  })
  .strict();
const processEvidence = z
  .object({
    key: text.describe("New provider key being verified."),
    provider: text.describe("Recorded process provider identifier."),
    legacyLabel: text
      .optional()
      .describe("Exact previous launchd label, when applicable."),
    outcome: z
      .enum(["adopted", "replaced", "verified-absent"])
      .describe("Verified ownership result."),
    observedAt: timestamp.describe("Time the provider observation was made."),
    previousOwner: z
      .enum(["unloaded", "absent", "adopted"])
      .describe("Observed condition of the old owner."),
    currentKey: text
      .optional()
      .describe(
        "Current owned provider key, required after adoption or replacement.",
      ),
  })
  .strict();
const routeEvidence = z
  .object({
    key: text.describe("New route owner key."),
    legacyMarker: text.describe("Exact previous ownership marker."),
    outcome: z
      .enum(["adopted", "removed"])
      .describe("Verified route ownership result."),
    observedAt: timestamp.describe("Time the route ownership was inspected."),
    currentKey: text.optional().describe("Current route key after adoption."),
  })
  .strict();
export const adoptionEvidenceSchema = z
  .object({
    verifiedAt: timestamp.describe("Time all observations were reconciled."),
    processes: z
      .array(processEvidence)
      .describe("One observation for each legacy managed process."),
    routes: z
      .array(routeEvidence)
      .describe("One observation for each legacy route."),
  })
  .strict();
export type AdoptionEvidence = z.infer<typeof adoptionEvidenceSchema>;
const base = {
  version: z.literal(1),
  sourceRevision: revisionSchema,
  backupPath: text.refine(isAbsolute),
  adoption: z.object({
    processes: z.array(pendingProcess),
    routes: z.array(pendingRoute),
  }),
  history: z.object({
    events: z.number().int().nonnegative(),
    acceptedReceipts: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    preservation: z.literal("original-files-and-exact-backups"),
  }),
  recoveredSources: z.array(z.unknown()).optional(),
  warnings: z.array(z.unknown()).optional(),
};
const pendingSchema = z
  .object({ ...base, status: z.literal("requires-adoption") })
  .strict();
const completedSchema = z
  .object({
    ...base,
    status: z.literal("completed"),
    verifiedAt: timestamp,
    pendingRevision: revisionSchema,
    evidence: adoptionEvidenceSchema,
  })
  .strict();
const manifestSchema = z.discriminatedUnion("status", [
  pendingSchema,
  completedSchema,
]);
export type AdoptionManifest = z.infer<typeof manifestSchema>;
const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
const pathFor = (root: string) => join(root, "runtime", "legacy-adoption.json");
function invalid(): RigError {
  return new RigError(
    "LEGACY_ADOPTION_INVALID",
    "Legacy adoption evidence is invalid.",
    "Restore the original pending manifest and verify every legacy owner before enabling runtime control.",
  );
}
function parseManifest(raw: string): AdoptionManifest {
  try {
    return manifestSchema.parse(JSON.parse(raw));
  } catch {
    throw invalid();
  }
}
/** Read-only evidence inspection. Completed records are checked against an exact preserved pending manifest. */
export async function readLegacyAdoption(
  root: string,
): Promise<{ revision: string; manifest: AdoptionManifest } | undefined> {
  const path = pathFor(root);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      for (const legacyPath of [
        join(root, "runtime", "rigd-state.json"),
        join(root, "registry.json"),
      ]) {
        try {
          await access(legacyPath);
        } catch (probe) {
          if (
            probe instanceof Error &&
            "code" in probe &&
            probe.code === "ENOENT"
          )
            continue;
          throw invalid();
        }
        throw invalid();
      }
      return undefined;
    }
    throw invalid();
  }
  const manifest = parseManifest(raw);
  if (manifest.status === "completed") {
    let priorRaw: string;
    try {
      priorRaw = await readFile(
        `${path}.${manifest.pendingRevision}.bak`,
        "utf8",
      );
    } catch {
      throw invalid();
    }
    const prior = parseManifest(priorRaw);
    const { status, verifiedAt, pendingRevision, evidence, ...original } =
      manifest;
    if (
      digest(priorRaw) !== manifest.pendingRevision ||
      prior.status !== "requires-adoption" ||
      !isDeepStrictEqual(prior, { ...original, status: "requires-adoption" }) ||
      manifest.verifiedAt !== manifest.evidence.verifiedAt
    )
      throw invalid();
    validateEvidence(prior, manifest.evidence);
  }
  return { revision: digest(raw), manifest };
}
/** Runtime mutation/reconciliation guard; unknown ownership never becomes authorization to start or stop. */
export function createAdoptionGuard(root: string): () => Promise<void> {
  return async () => {
    const record = await readLegacyAdoption(root);
    if (record?.manifest.status === "requires-adoption")
      throw new RigError(
        "LEGACY_ADOPTION_PENDING",
        "Legacy provider adoption is still pending.",
        "Verify and finalize every legacy process and route before runtime control.",
      );
  };
}
function validateEvidence(
  manifest: z.infer<typeof pendingSchema>,
  evidence: AdoptionEvidence,
): void {
  const processMap = new Map(
      evidence.processes.map((entry) => [entry.key, entry]),
    ),
    routeMap = new Map(evidence.routes.map((entry) => [entry.key, entry]));
  if (
    processMap.size !== evidence.processes.length ||
    routeMap.size !== evidence.routes.length ||
    processMap.size !== manifest.adoption.processes.length ||
    routeMap.size !== manifest.adoption.routes.length
  )
    throw invalid();
  const latest = Date.parse(evidence.verifiedAt);
  for (const owner of manifest.adoption.processes) {
    const observed = processMap.get(owner.key);
    if (
      !observed ||
      observed.provider !== owner.provider ||
      observed.legacyLabel !== owner.legacyLabel ||
      Date.parse(observed.observedAt) > latest
    )
      throw invalid();
    if (observed.outcome === "adopted") {
      if (
        observed.previousOwner !== "adopted" ||
        observed.currentKey !== owner.key
      )
        throw invalid();
    } else {
      if (
        observed.previousOwner !== (owner.legacyLabel ? "unloaded" : "absent")
      )
        throw invalid();
      if (observed.outcome === "replaced" && observed.currentKey !== owner.key)
        throw invalid();
      if (
        observed.outcome === "verified-absent" &&
        observed.currentKey !== undefined
      )
        throw invalid();
    }
  }
  for (const owner of manifest.adoption.routes) {
    const observed = routeMap.get(owner.key);
    if (
      !observed ||
      observed.legacyMarker !== owner.legacyMarker ||
      Date.parse(observed.observedAt) > latest ||
      (observed.outcome === "adopted"
        ? observed.currentKey !== owner.key
        : observed.currentKey !== undefined)
    )
      throw invalid();
  }
}
/** Explicit filesystem finalization; callers supply real provider observations, never an unqualified ready flag. */
export async function finalizeLegacyAdoption(
  root: string,
  input: { expectedRevision: string; evidence: AdoptionEvidence },
): Promise<{ path: string; backupPath: string; revision: string }> {
  const evidenceResult = adoptionEvidenceSchema.safeParse(input.evidence);
  if (
    !revisionSchema.safeParse(input.expectedRevision).success ||
    !evidenceResult.success
  )
    throw invalid();
  const path = pathFor(root),
    lockPath = `${path}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new RigError(
      "LEGACY_ADOPTION_LOCKED",
      "Another legacy adoption finalization may be running.",
      "Inspect the adoption lock before retrying.",
    );
  }
  let temporary: string | undefined;
  try {
    const raw = await readFile(path, "utf8"),
      pending = parseManifest(raw);
    if (digest(raw) !== input.expectedRevision)
      throw new RigError(
        "LEGACY_ADOPTION_CHANGED",
        "The adoption manifest changed since it was reviewed.",
        "Read the current manifest revision before retrying.",
      );
    if (pending.status !== "requires-adoption")
      throw new RigError(
        "LEGACY_ADOPTION_COMPLETED",
        "Legacy adoption is already complete.",
        "Inspect its verified ownership evidence.",
      );
    validateEvidence(pending, evidenceResult.data);
    const backupPath = `${path}.${input.expectedRevision}.bak`;
    try {
      await writeFile(backupPath, raw, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ) ||
        digest(await readFile(backupPath, "utf8")) !== input.expectedRevision
      )
        throw invalid();
    }
    const completed = completedSchema.parse({
      ...pending,
      status: "completed",
      verifiedAt: evidenceResult.data.verifiedAt,
      pendingRevision: input.expectedRevision,
      evidence: evidenceResult.data,
    });
    const output = JSON.stringify(completed, null, 2) + "\n";
    temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(output);
      await file.sync();
    } finally {
      await file.close();
    }
    if (digest(await readFile(path, "utf8")) !== input.expectedRevision)
      throw new RigError(
        "LEGACY_ADOPTION_CHANGED",
        "The adoption manifest changed during finalization.",
        "Read its new revision before retrying.",
      );
    await rename(temporary, path);
    temporary = undefined;
    return { path, backupPath, revision: digest(output) };
  } finally {
    if (temporary) await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

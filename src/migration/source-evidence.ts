import { z } from "zod";
import type { LegacyState, LegacyRecord } from "./schema";
import type { MigrationIssue, RecoveredSource } from "./types";
const evidenceSchema = z
  .object({
    project: z.string().min(1).describe("Legacy Project identity."),
    target: z.string().min(1).describe("Legacy Target identity."),
    branch: z.string().min(1).describe("Recovered deployed Branch."),
    commit: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      .describe("Recovered deployed Commit."),
    evidence: z
      .string()
      .min(1)
      .max(4000)
      .describe("Source-verification provenance; never include secret values."),
  })
  .strict();
const executionSchema = z.object({
  project: z.string(),
  deployment: z.string(),
  kind: z.enum(["local", "live", "generated"]),
  operations: z.array(z.string()),
  providerProfile: z.string(),
  events: z.array(z.unknown()),
});
/** Applies explicitly supplied recovery only when the latest recorded completed deploy execution matches.
 * The caller separately verifies surviving workspace contents and supplies that provenance as evidence.
 * Legacy "accepted" events lacking an execution result cannot prove materialization.
 */
export function recoverSources(
  input: { legacy: LegacyState; inventories: LegacyRecord[] },
  requested: readonly RecoveredSource[],
): {
  legacy: LegacyState;
  inventories: LegacyRecord[];
  issues: MigrationIssue[];
  recoveredSources: RecoveredSource[];
} {
  const legacy = structuredClone(input.legacy),
    inventories = structuredClone(input.inventories),
    issues: MigrationIssue[] = [],
    recoveredSources: RecoveredSource[] = [],
    seen = new Set<string>();
  for (const raw of requested) {
    const parsed = evidenceSchema.safeParse(raw);
    if (!parsed.success) {
      issues.push({
        code: "unverified_recovered_source",
        message: "Recovered source evidence is incomplete or invalid.",
      });
      continue;
    }
    const evidence = parsed.data,
      key = `${evidence.project}:${evidence.target}`;
    const desired = legacy.desiredDeployments.find(
      (value) =>
        value.project === evidence.project &&
        value.deployment === evidence.target,
    );
    const events = legacy.events
      .filter(
        (event) =>
          event.project === evidence.project &&
          event.event === "rigd.deploy.accepted" &&
          (event.deployment === evidence.target ||
            event.details?.target === evidence.target),
      )
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const latest = events.at(-1),
      execution = executionSchema.safeParse(latest?.details?.execution);
    if (
      seen.has(key) ||
      inventories.some(
        (record) =>
          record.project === evidence.project &&
          record.name === evidence.target &&
          ((record.sourceRef && record.sourceRef !== evidence.branch) ||
            (record.sourceCommit && record.sourceCommit !== evidence.commit)),
      ) ||
      !desired ||
      desired.kind === "local" ||
      !execution.success ||
      execution.data.project !== evidence.project ||
      execution.data.deployment !== evidence.target ||
      execution.data.kind !== desired.kind ||
      execution.data.providerProfile === "stub" ||
      !execution.data.operations.includes(
        `workspace-materializer:git-worktree:materialize:${desired.record.workspacePath}:${evidence.commit}`,
      ) ||
      latest?.details?.ref !== evidence.branch ||
      latest.details.commit !== evidence.commit ||
      (desired.record.sourceRef &&
        desired.record.sourceRef !== evidence.branch) ||
      (desired.record.sourceCommit &&
        desired.record.sourceCommit !== evidence.commit)
    ) {
      issues.push({
        code: "unverified_recovered_source",
        message:
          "Recovered Branch/Commit does not match the latest completed legacy deployment execution.",
        project: evidence.project,
        target: evidence.target,
      });
      continue;
    }
    seen.add(key);
    desired.record.sourceRef = evidence.branch;
    desired.record.sourceCommit = evidence.commit;
    for (const record of inventories)
      if (
        record.project === evidence.project &&
        record.name === evidence.target
      ) {
        record.sourceRef = evidence.branch;
        record.sourceCommit = evidence.commit;
      }
    recoveredSources.push(evidence);
  }
  return { legacy, inventories, issues, recoveredSources };
}

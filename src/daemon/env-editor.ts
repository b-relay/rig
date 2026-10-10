import { z } from "zod";
import { RigError } from "../domain/errors";
import { TARGET_ROLES } from "../config/schema";
import {
  describeEnvFile,
  envScopeFile,
  revealEnvValue,
  writeEnvFile,
  type EnvFileView,
  type EnvScope,
} from "../adapters/env-store";
import { ABSENT_REVISION, ENV_KEY } from "../adapters/env-file-edit";
import type { OperationRecord } from "../domain/runtime";

const name = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  .max(128);
const scopeSchema = z
  .strictObject({
    service: name
      .optional()
      .describe("A Service in rig.yaml; absent for the Project's own files."),
    role: z
      .enum(TARGET_ROLES)
      .optional()
      .describe(
        "The Target role whose file this is; absent for all.env, which every role reads.",
      ),
  })
  .describe("Which operator env file under <RIG_ROOT>/env/<project>.");
const key = z
  .string()
  .regex(ENV_KEY)
  .max(256)
  .describe("A name the file assigns.");
const changeSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("set").describe("Assign a value, replacing any earlier one."),
    key,
    value: z
      .string()
      .max(65536)
      .describe("The value; never logged or recorded."),
  }),
  z.strictObject({
    op: z.literal("remove").describe("Remove every assignment of the name."),
    key,
  }),
]);
export const envEditorRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z
      .literal("read")
      .describe("Describe every operator env file of the Project, names only."),
    project: name.describe("Registered Project name."),
  }),
  z.strictObject({
    action: z
      .literal("reveal")
      .describe("Answer one value, for an operator who asked to see it."),
    project: name.describe("Registered Project name."),
    scope: scopeSchema,
    key,
  }),
  z.strictObject({
    action: z
      .literal("write")
      .describe(
        "Apply changes atomically if the file still has the revision read.",
      ),
    project: name.describe("Registered Project name."),
    scope: scopeSchema,
    expectedRevision: z
      .string()
      .regex(new RegExp(`^(?:[a-f0-9]{64}|${ABSENT_REVISION})$`))
      .describe("The revision the last read returned for this file."),
    changes: z.array(changeSchema).min(1).max(100).describe("Ordered changes."),
    actor: z
      .string()
      .regex(/^[A-Za-z0-9 .:()_/-]{1,80}$/)
      .describe(
        "Who asked, as the dashboard names its client; recorded in Activity with the names changed.",
      ),
  }),
]);
export type EnvEditorRequest = z.infer<typeof envEditorRequestSchema>;
export interface EnvEditorDependencies {
  /** `<RIG_ROOT>/env`, where operator env files live. */
  envRoot: string;
  resolveProject(
    name: string,
  ): Promise<{ id: string; name: string; repoPath: string } | undefined>;
  /** The Service names the Project's rig.yaml declares, sorted. */
  services(repoPath: string): Promise<string[]>;
  /** Runs `operation` while no other mutation of the named Project runs. */
  exclusive<T>(project: string, operation: () => Promise<T>): Promise<T>;
  /** Appends one final Operation to Activity. */
  record(operation: OperationRecord): Promise<void>;
  now(): string;
  id(): string;
}
/** What `read` answers: every operator env file the Project's processes may load, names only. */
export interface EnvFiles {
  project: string;
  /** `<RIG_ROOT>/env/<project>`. */
  directory: string;
  services: string[];
  files: EnvFileView[];
}
/** Pure: every scope a Project's operator env files cover: the Project's, then each Service's, each for all
 * roles and then for each role, in the order resolve.ts layers them. */
export function envScopes(services: readonly string[]): EnvScope[] {
  const roles = [undefined, ...TARGET_ROLES];
  return [undefined, ...services].flatMap((service) =>
    roles.map((role) => ({
      ...(service ? { service } : {}),
      ...(role ? { role } : {}),
    })),
  );
}
/** Pure: the Activity message for a write: who, which names, and which file, never a value. */
export function envChangeMessage(
  actor: string,
  scope: EnvScope,
  changes: readonly { op: "set" | "remove"; key: string }[],
): string {
  const names = (op: "set" | "remove") => [
    ...new Set(
      changes.filter((each) => each.op === op).map((each) => each.key),
    ),
  ];
  const set = names("set"),
    removed = names("remove");
  const file = `${scope.service ? `${scope.service}/` : ""}${scope.role ?? "all"}.env`;
  return `${actor} ${[
    set.length ? `set ${set.join(", ")}` : "",
    removed.length ? `removed ${removed.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ")} in ${file}`;
}
/** Authenticated transport adapter for operator env files (secrets). It accepts a registered Project and a
 * scope, never a path, so it can only touch `<RIG_ROOT>/env/<project>/...`. Values leave only through
 * `reveal`; they are never logged, recorded in Activity, or named in an error. */
export function createEnvEditor(dependencies: EnvEditorDependencies) {
  const registered = async (project: string) => {
    const found = await dependencies.resolveProject(project);
    if (!found)
      throw new RigError(
        "PROJECT_MISSING",
        `Project '${project}' is not registered.`,
        "Register the Project with rig init first.",
      );
    return found;
  };
  const knownScope = async (
    found: { repoPath: string; name: string },
    scope: EnvScope,
  ) => {
    if (
      scope.service &&
      !(await dependencies.services(found.repoPath)).includes(scope.service)
    )
      throw new RigError(
        "ENV_SCOPE",
        `${found.name}'s rig.yaml has no Service named '${scope.service}'.`,
        "Choose one of the Services rig.yaml declares, or the Project's own files.",
        { service: scope.service },
      );
    return envScopeFile(dependencies.envRoot, found.name, scope);
  };
  return async (input: unknown): Promise<unknown> => {
    const parsed = envEditorRequestSchema.safeParse(input);
    // The rejected input is never echoed: it may hold a value.
    if (!parsed.success)
      throw new RigError(
        "INVALID_REQUEST",
        "Invalid env editor request.",
        "Use read, reveal, or write with a registered Project, a scope, and valid names.",
      );
    const request = parsed.data;
    const found = await registered(request.project);
    if (request.action === "read") {
      const services = await dependencies.services(found.repoPath);
      return {
        project: found.name,
        directory: envScopeFile(dependencies.envRoot, found.name, {}).replace(
          /\/all\.env$/,
          "",
        ),
        services,
        files: await Promise.all(
          envScopes(services).map((scope) =>
            describeEnvFile(
              envScopeFile(dependencies.envRoot, found.name, scope),
              scope,
            ),
          ),
        ),
      } satisfies EnvFiles;
    }
    const path = await knownScope(found, request.scope);
    if (request.action === "reveal")
      return { value: await revealEnvValue(path, request.key) };
    return dependencies.exclusive(found.name, async () => {
      const view = await writeEnvFile(
        path,
        request.scope,
        request.expectedRevision,
        request.changes,
        dependencies.envRoot,
      );
      try {
        await dependencies.record({
          id: dependencies.id(),
          projectId: found.id,
          project: found.name,
          // working and stable name their Target; preview.env is every Preview's, which the message names.
          ...(request.scope.role && request.scope.role !== "preview"
            ? { target: request.scope.role }
            : {}),
          action: "env",
          outcome: "updated",
          occurredAt: dependencies.now(),
          message: envChangeMessage(
            request.actor,
            request.scope,
            request.changes,
          ),
        });
      } catch {
        // The file is written; a lost record must not make the save look failed and its retry conflict.
        return {
          ...view,
          warning:
            "Saved, but Activity could not record it; rig doctor and the rigd diagnostic log say why.",
        };
      }
      return view;
    });
  };
}

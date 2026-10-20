import { z } from "zod";
import { RigError } from "../domain/errors";
import { TARGET_ROLES } from "../config/schema";
import {
  assertNoSymlinkBelow,
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
      .describe(
        "A Service in rig.yaml; absent for the Project's own files and a Job's.",
      ),
    job: name
      .optional()
      .describe(
        "A Job in rig.yaml, whose runs, backups and restores read its files; absent for the Project's own files and a Service's.",
      ),
    role: z
      .enum(TARGET_ROLES)
      .optional()
      .describe(
        "The Target role whose file this is; absent for all.env, which every role reads.",
      ),
  })
  .refine((scope) => !(scope.service && scope.job), {
    message: "A scope names a Service or a Job, not both.",
  })
  .describe("Which operator env file under <RIG_ROOT>/env/<project>.");
const key = z
  .string()
  .regex(ENV_KEY)
  .max(256)
  .describe("A name the file assigns; names starting with _RIG_ are reserved.");
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
      .describe(
        "The revision of the file the changes were made against; a file that has moved since is refused, never overwritten.",
      ),
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
const envFileViewSchema = z.object({
  scope: scopeSchema,
  path: z.string().min(1).describe("The file's path."),
  exists: z.boolean().describe("Whether the file exists."),
  revision: z.string().min(1).describe("Revision a write must name."),
  keys: z.array(z.string()).describe("The names it assigns, in file order."),
  mode: z.number().int().optional().describe("Permission bits."),
  problem: z
    .string()
    .optional()
    .describe("Why the file cannot be read or edited."),
});
/** What each env editor action answers: every file by name, one value, or the file a write left. */
export const envEditorReplySchemas = {
  read: z.object({
    project: name.describe("Registered Project name."),
    directory: z.string().min(1).describe("<RIG_ROOT>/env/<project>."),
    services: z.array(name).describe("The Services rig.yaml declares."),
    jobs: z.array(name).describe("The Jobs rig.yaml declares."),
    files: z.array(envFileViewSchema).describe("Every operator env file."),
  }),
  reveal: z.object({
    value: z.string().describe("The value asked for."),
    revision: z
      .string()
      .min(1)
      .describe(
        "The revision of the file the value was read from; once the file has another, the value is no longer current.",
      ),
  }),
  write: envFileViewSchema.extend({
    warning: z
      .string()
      .optional()
      .describe("Set when the write landed but Activity could not record it."),
  }),
} as const;
export interface EnvEditorDependencies {
  /** `<RIG_ROOT>/env`, where operator env files live. */
  envRoot: string;
  resolveProject(
    name: string,
  ): Promise<{ id: string; name: string; repoPath: string } | undefined>;
  /** The Service and Job names the Project's rig.yaml declares, each sorted. */
  declared(repoPath: string): Promise<{ services: string[]; jobs: string[] }>;
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
  jobs: string[];
  files: EnvFileView[];
}
/** Pure: every scope a Project's operator env files cover: the Project's, then each Service's, then each Job's,
 * each for all roles and then for each role, in the order resolve.ts layers them. */
export function envScopes(
  services: readonly string[],
  jobs: readonly string[] = [],
): EnvScope[] {
  const roles = [undefined, ...TARGET_ROLES];
  const owners: EnvScope[] = [
    {},
    ...services.map((service) => ({ service })),
    ...jobs.map((job) => ({ job })),
  ];
  return owners.flatMap((owner) =>
    roles.map((role) => ({ ...owner, ...(role ? { role } : {}) })),
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
  const owner = scope.service ?? scope.job;
  const file = `${owner ? `${owner}/` : ""}${scope.role ?? "all"}.env`;
  return `${actor} ${[
    set.length ? `set ${set.join(", ")}` : "",
    removed.length ? `removed ${removed.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ")} in ${file}`;
}
/** Authenticated transport adapter for operator env files (secrets). It accepts a registered Project and a
 * scope, never a path, so it can only touch `<RIG_ROOT>/env/<project>/...`. Values leave only through
 * `reveal`; they are never logged, recorded in Activity, or named in an error. Every answer carries the
 * revision it was read from, and a write lands only on the revision it names. */
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
    if (scope.service || scope.job) {
      const declared = await dependencies.declared(found.repoPath);
      if (scope.service && !declared.services.includes(scope.service))
        throw new RigError(
          "ENV_SCOPE",
          `${found.name}'s rig.yaml has no Service named '${scope.service}'.`,
          "Choose one of the Services or Jobs rig.yaml declares, or the Project's own files.",
          { service: scope.service },
        );
      if (scope.job && !declared.jobs.includes(scope.job))
        throw new RigError(
          "ENV_SCOPE",
          `${found.name}'s rig.yaml has no Job named '${scope.job}'.`,
          "Choose one of the Services or Jobs rig.yaml declares, or the Project's own files.",
          { job: scope.job },
        );
    }
    const path = envScopeFile(dependencies.envRoot, found.name, scope);
    await assertNoSymlinkBelow(dependencies.envRoot, path);
    return path;
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
      const { services, jobs } = await dependencies.declared(found.repoPath);
      return {
        project: found.name,
        directory: envScopeFile(dependencies.envRoot, found.name, {}).replace(
          /\/all\.env$/,
          "",
        ),
        services,
        jobs,
        files: await Promise.all(
          envScopes(services, jobs).map(async (scope) => {
            const path = envScopeFile(dependencies.envRoot, found.name, scope);
            await assertNoSymlinkBelow(dependencies.envRoot, path);
            return describeEnvFile(path, scope);
          }),
        ),
      } satisfies EnvFiles;
    }
    if (request.action === "reveal")
      return revealEnvValue(
        await knownScope(found, request.scope),
        request.key,
      );
    return dependencies.exclusive(found.name, async () => {
      // A rename, forget or repoint may have finished while this waited: the Project and its scope are read again
      // here, and a name that now denotes another registration is refused rather than written for it.
      const current = await registered(request.project);
      if (current.id !== found.id)
        throw new RigError(
          "PROJECT_CHANGED",
          `Project '${request.project}' was registered anew while this change waited, so nothing was written.`,
          "Read the env files again and make the change on the Project as it is now.",
          { project: request.project },
        );
      const path = await knownScope(current, request.scope);
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
          projectId: current.id,
          project: current.name,
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

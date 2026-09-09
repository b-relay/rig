import { z } from "zod";
import { ConfigError } from "../config/errors.js";
import { validateEditPath } from "../config/editor.js";
import { projectConfigSchema } from "../config/schema.js";
import type {
  ConfigEditInput,
  ProjectConfigPreview,
  ProjectConfigSource,
} from "../config/documents.js";

const pathSchema = z
  .array(z.string().min(1).max(256))
  .min(1)
  .max(16)
  .describe("Structured supported config field path.");
const patchSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("set").describe("Set a field."),
      path: pathSchema,
      value: z
        .unknown()
        .refine((value) => value !== undefined)
        .describe("New schema-valid field value."),
    })
    .strict(),
  z
    .object({
      op: z.literal("remove").describe("Remove an optional field."),
      path: pathSchema,
    })
    .strict(),
]);
const project = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  .max(128)
  .describe("Registered Project name.");
const mutation = {
  project,
  expectedRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe("Revision returned by the last config read."),
  patch: z
    .array(patchSchema)
    .min(1)
    .max(100)
    .describe("Ordered structured edits."),
};
export const configEditorRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("read").describe("Read the registered config."),
      project,
    })
    .strict(),
  z
    .object({
      action: z
        .literal("preview")
        .describe("Validate and preview without writing."),
      ...mutation,
    })
    .strict(),
  z
    .object({
      action: z
        .literal("apply")
        .describe("Apply with revision protection and a backup."),
      ...mutation,
    })
    .strict(),
]);
export type ConfigEditorRequest = z.infer<typeof configEditorRequestSchema>;
export interface ConfigEditorDependencies {
  resolveProject(
    name: string,
  ): Promise<{ name: string; repoPath: string } | undefined>;
  documents: {
    read(repoPath: string): Promise<ProjectConfigSource>;
    preview(input: ConfigEditInput): Promise<ProjectConfigPreview>;
    apply(
      input: ConfigEditInput,
    ): Promise<ProjectConfigPreview & { backupPath: string }>;
  };
  /** Share the runtime mutation queue so Project rename/repoint cannot race an apply. */
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
}
interface Field {
  path: string;
  description: string;
  valueShape: string;
}
interface SchemaNode {
  type?: string;
  description?: string;
  properties?: Record<string, SchemaNode>;
  additionalProperties?: SchemaNode | boolean;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  propertyNames?: { pattern?: string };
}
const schema = z.toJSONSchema(projectConfigSchema) as SchemaNode;
function children(node: SchemaNode): SchemaNode[] {
  return [node, ...(node.anyOf ?? node.oneOf ?? []).flatMap(children)];
}
function pathSupported(node: SchemaNode, path: readonly string[]): boolean {
  if (!path.length) return true;
  const [key, ...rest] = path;
  return children(node).some((variant) => {
    const exact =
      variant.properties && Object.hasOwn(variant.properties, key!)
        ? variant.properties[key!]
        : undefined;
    if (exact) return pathSupported(exact, rest);
    const dynamic = variant.additionalProperties;
    return (
      typeof dynamic === "object" &&
      (!variant.propertyNames?.pattern ||
        new RegExp(variant.propertyNames.pattern).test(key!)) &&
      pathSupported(dynamic, rest)
    );
  });
}
function describeFields(node: SchemaNode, prefix: string[] = []): Field[] {
  const fields: Field[] = [];
  for (const variant of children(node)) {
    if (prefix.length && prefix[0] !== "name")
      fields.push({
        path: prefix.join("."),
        description:
          variant.description ?? node.description ?? "Structured config field.",
        valueShape: variant.type ?? "union",
      });
    for (const [key, child] of Object.entries(variant.properties ?? {}))
      fields.push(...describeFields(child, [...prefix, key]));
    if (typeof variant.additionalProperties === "object")
      fields.push(
        ...describeFields(variant.additionalProperties, [...prefix, "*"]),
      );
  }
  return [...new Map(fields.map((field) => [field.path, field])).values()];
}
const fields = describeFields(schema);
function getField(value: unknown, path: readonly string[]): unknown {
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Authenticated transport adapter: accepts a registered identity, never filesystem paths or generic writes. */
export function createConfigEditor(dependencies: ConfigEditorDependencies) {
  return async (input: unknown) => {
    const parsed = configEditorRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new ConfigError(
        "Invalid config editor request.",
        "invalid_edit",
        {},
        "Use read, preview, or apply with a registered Project and supported field paths.",
      );
    const request = parsed.data;
    if (request.action !== "read")
      for (const edit of request.patch) {
        validateEditPath(edit.path);
        if (edit.path[0] === "name")
          throw new ConfigError(
            "Project identity changes require rename.",
            "identity_change",
            {},
            "Use rig rename to keep registration, routes, and the Git remote coherent.",
          );
        if (!pathSupported(schema, edit.path))
          throw new ConfigError(
            "Unsupported config field path.",
            "invalid_edit",
          );
      }
    const execute = async () => {
      const registered = await dependencies.resolveProject(request.project);
      if (!registered)
        throw new ConfigError(
          "Project is not registered.",
          "project_missing",
          { project: request.project },
          "Register the Project with rig init first.",
        );
      const before = await dependencies.documents.read(registered.repoPath);
      if (before.config.name !== registered.name)
        throw new ConfigError(
          "Config name differs from registered identity.",
          "identity_mismatch",
          {},
          "Restore the registered name, then use rig rename.",
        );
      if (request.action === "read")
        return {
          project: registered.name,
          configPath: before.path,
          revision: before.revision,
          raw: before.raw,
          config: before.config,
          fields,
        };
      const change = {
        repoPath: registered.repoPath,
        expectedRevision: request.expectedRevision,
        edits: request.patch,
      };
      // Compare the same source used for the diff; documents recheck before any write.
      if (before.revision !== request.expectedRevision)
        throw new ConfigError(
          "Config changed since it was read.",
          "revision_conflict",
          {},
          "Read the current config before retrying the edit.",
        );
      const result =
        request.action === "apply"
          ? await dependencies.documents.apply(change)
          : await dependencies.documents.preview(change);
      return {
        project: registered.name,
        configPath: result.path,
        baseRevision: result.baseRevision,
        nextRevision: result.revision,
        patch: request.patch,
        raw: result.raw,
        config: result.config,
        diff: request.patch.map((edit) => ({
          path: edit.path.join("."),
          before: getField(before.config, edit.path),
          after: getField(result.config, edit.path),
        })),
        ...(request.action === "apply" && "backupPath" in result
          ? { applied: true as const, backupPath: result.backupPath }
          : {}),
      };
    };
    return request.action === "apply"
      ? dependencies.exclusive(execute)
      : execute();
  };
}

import { z } from "zod";
import { ConfigError } from "./errors";
import {
  DEFAULT_TARGET_NAMES,
  hostConfigSchema,
  projectConfigSchema,
} from "./schema";

/** Where the committed schema files are served from; an editor fetches them by this address. */
const SCHEMA_BASE =
  "https://raw.githubusercontent.com/b-relay/rig/main/schemas";
export const PROJECT_SCHEMA_URL = `${SCHEMA_BASE}/rig.schema.json`;
export const HOST_SCHEMA_URL = `${SCHEMA_BASE}/host-config.schema.json`;
/** The comment that makes yaml-language-server check and complete a rig.yaml against the Project schema. */
export const PROJECT_SCHEMA_COMMENT = `# yaml-language-server: $schema=${PROJECT_SCHEMA_URL}\n`;

export type JsonSchema = Record<string, unknown>;
/** One schema per committed file, keyed by its name in schemas/. */
export interface ConfigJsonSchemas {
  readonly "rig.schema.json": JsonSchema;
  readonly "host-config.schema.json": JsonSchema;
}

/** Defaults planning applies when a setting is absent, by the setting's path in the Project schema. The Zod schema leaves these
 * settings optional so the parsed config stays what the author wrote; the JSON Schema shows the value for an editor. Only fixed
 * values belong here: a setting that falls back to another setting (a Service build_timeout) has none.
 * tests/config-json-schema.test.ts holds each entry to what resolveTargetPlan does. */
const PLANNING_DEFAULTS: readonly (readonly [string[], string])[] = [
  [["supervisor"], "rigd"],
  [["build_timeout"], "10m"],
  [["services", "*", "ready_timeout"], "30s"],
  [["services", "*", "restart"], "always"],
  [["targets", "working", "name"], DEFAULT_TARGET_NAMES.working],
  [["targets", "stable", "name"], DEFAULT_TARGET_NAMES.stable],
];

/** The schema of the setting at a config path, where '*' stands for any key of a map. */
function settingAt(schema: JsonSchema, path: readonly string[]): JsonSchema {
  let node = schema;
  for (const segment of path) {
    const next =
      segment === "*"
        ? node.additionalProperties
        : (node.properties as Record<string, unknown> | undefined)?.[segment];
    if (typeof next !== "object" || next === null)
      throw new ConfigError(
        `No setting ${path.join(".")} in the Project schema.`,
        "SCHEMA_DEFAULT_PATH",
        { path: path.join(".") },
        "Update PLANNING_DEFAULTS in src/config/json-schema.ts to match the Project schema.",
      );
    node = next as JsonSchema;
  }
  return node;
}

function jsonSchemaOf(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    override: ({ zodSchema, jsonSchema }) => {
      // A pipe that starts from `unknown` only pre-checks raw input; the shape an author writes is its output side.
      if (
        zodSchema instanceof z.ZodPipe &&
        zodSchema.in instanceof z.ZodUnknown
      )
        Object.assign(
          jsonSchema,
          withoutDialect(
            z.toJSONSchema(zodSchema.out, { unrepresentable: "any" }),
          ),
        );
    },
  }) as JsonSchema;
}
function withoutDialect(schema: JsonSchema): JsonSchema {
  const { $schema: _dialect, ...rest } = schema;
  return rest;
}

/** Pure: the JSON Schemas of the Project and Host config, keyed by the file name each is committed under in schemas/. */
export function configJsonSchemas(): ConfigJsonSchemas {
  const { $schema: dialect, ...project } = jsonSchemaOf(projectConfigSchema);
  for (const [path, value] of PLANNING_DEFAULTS)
    settingAt(project, path).default = value;
  const host = withoutDialect(jsonSchemaOf(hostConfigSchema));
  return {
    "rig.schema.json": {
      $schema: dialect,
      $id: PROJECT_SCHEMA_URL,
      title: "Rig Project config (rig.yaml)",
      description:
        "Committed Project intent: identity, Services, Tools, routes and Target patches.",
      ...project,
    },
    "host-config.schema.json": {
      $schema: dialect,
      $id: HOST_SCHEMA_URL,
      title: "Rig Host config (config.yaml)",
      description:
        "Machine capability in <RIG_ROOT>/config.yaml; every key is optional.",
      ...host,
    },
  };
}

/** The exact bytes of a committed schema file: two-space JSON and a trailing newline. */
export function renderJsonSchema(schema: JsonSchema): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

import { z } from "zod";
import { ConfigError } from "./errors";
import { DEFAULT_STOP_TIMEOUT_SECONDS } from "../domain/stop-budget";
import {
  DEFAULT_HEALTH_FAILURES,
  DEFAULT_HEALTH_ON_FAILURE,
  DEFAULT_HEALTH_TIMEOUT_SECONDS,
  DEFAULT_RESTART_POLICY,
} from "./plan-defaults";
import {
  DEFAULT_TARGET_NAMES,
  hostConfigSchema,
  projectConfigSchemas,
} from "./schema";
import {
  LATEST_FORMAT,
  UNDECLARED_FORMAT,
  servicePathIn,
  type ConfigFormat,
} from "./formats";

/** Where the committed schema files are served from; an editor fetches them by this address. */
const SCHEMA_BASE =
  "https://raw.githubusercontent.com/b-relay/rig/main/schemas";
export const PROJECT_SCHEMA_URL = `${SCHEMA_BASE}/rig.schema.json`;
/** The schema of the deprecated rig/v1 format, which a file not yet upgraded may point its editor at. */
export const PROJECT_V1_SCHEMA_URL = `${SCHEMA_BASE}/rig-v1.schema.json`;
export const HOST_SCHEMA_URL = `${SCHEMA_BASE}/host-config.schema.json`;
/** The comment that makes yaml-language-server check and complete a rig.yaml against the Project schema. */
export const PROJECT_SCHEMA_COMMENT = `# yaml-language-server: $schema=${PROJECT_SCHEMA_URL}\n`;

export type JsonSchema = Record<string, unknown>;
/** One schema per committed file, keyed by its name in schemas/. rig.schema.json is the current rig.yaml format; each
 * older format a rig.yaml may still declare keeps a schema of its own, frozen as it was. */
export interface ConfigJsonSchemas {
  readonly "rig.schema.json": JsonSchema;
  readonly "rig-v1.schema.json": JsonSchema;
  readonly "host-config.schema.json": JsonSchema;
}

/** Defaults planning applies when a setting is absent, by the setting's path in the Project schema. The Zod schema leaves these
 * settings optional so the parsed config stays what the author wrote; the JSON Schema shows the value for an editor. Only fixed
 * values belong here: a setting that falls back to another setting (a Service build_timeout) has none.
 * tests/config-json-schema.test.ts holds each entry to what resolveTargetPlan does. */
const planningDefaults = (
  format: ConfigFormat,
): readonly (readonly [readonly string[], string | number])[] => [
  [["supervisor"], "rigd"],
  [["build_timeout"], "10m"],
  [
    ["services", "*", ...servicePathIn(format, ["health", "start_timeout"])],
    "30s",
  ],
  [["services", "*", "stop_timeout"], `${DEFAULT_STOP_TIMEOUT_SECONDS}s`],
  [["services", "*", "restart"], DEFAULT_RESTART_POLICY],
  ...(format === UNDECLARED_FORMAT
    ? []
    : ([
        [
          ["services", "*", "health", "timeout"],
          `${DEFAULT_HEALTH_TIMEOUT_SECONDS}s`,
        ],
        [["services", "*", "health", "failures"], DEFAULT_HEALTH_FAILURES],
        [["services", "*", "health", "on_failure"], DEFAULT_HEALTH_ON_FAILURE],
      ] as const)),
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
        "Update planningDefaults in src/config/json-schema.ts to match the Project schema.",
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

/** The Project schema of one format, with the defaults planning applies shown on their settings. */
function projectJsonSchema(format: ConfigFormat): JsonSchema {
  const project = jsonSchemaOf(projectConfigSchemas[format]);
  for (const [path, value] of planningDefaults(format))
    settingAt(project, path).default = value;
  return project;
}
/** Pure: the JSON Schemas of the Project and Host config, keyed by the file name each is committed under in schemas/. */
export function configJsonSchemas(): ConfigJsonSchemas {
  const { $schema: dialect, ...project } = projectJsonSchema(LATEST_FORMAT);
  const v1 = withoutDialect(projectJsonSchema(UNDECLARED_FORMAT));
  const host = withoutDialect(jsonSchemaOf(hostConfigSchema));
  return {
    "rig.schema.json": {
      $schema: dialect,
      $id: PROJECT_SCHEMA_URL,
      title: "Rig Project config (rig.yaml)",
      description: `Committed Project intent: identity, Services, Tools, routes and Target patches, in format ${LATEST_FORMAT}. A rig.yaml without format is ${UNDECLARED_FORMAT}, described by rig-v1.schema.json; rig config upgrade rewrites it to ${LATEST_FORMAT}.`,
      ...project,
    },
    "rig-v1.schema.json": {
      $schema: dialect,
      $id: PROJECT_V1_SCHEMA_URL,
      title: `Rig Project config (rig.yaml), format ${UNDECLARED_FORMAT}`,
      description: `The deprecated ${UNDECLARED_FORMAT} format: a rig.yaml without format. Rig still reads it and warns; rig config upgrade rewrites the file to ${LATEST_FORMAT}, described by rig.schema.json.`,
      deprecated: true,
      ...v1,
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

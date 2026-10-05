/** Config module: document I/O, validation, and pure Target plan resolution. */
export * from "./types";
export * from "./errors";
export * from "./documents";
export {
  parseProjectConfig,
  parseHostConfig,
  projectConfigSchema,
  hostConfigSchema,
  patchedSettings,
  targetOn,
  rolePatch,
  PREVIEW_SELECTOR,
  TARGET_ROLES,
  WORKING_TOOL_SUFFIX,
  type TargetRole,
  type ProjectSettings,
} from "./schema";
export { resolveTargetPlan } from "./resolve";
export {
  configJsonSchemas,
  renderJsonSchema,
  PROJECT_SCHEMA_URL,
  HOST_SCHEMA_URL,
  PROJECT_SCHEMA_COMMENT,
  type JsonSchema,
} from "./json-schema";

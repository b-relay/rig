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
  targetNames,
  DEFAULT_TARGET_NAMES,
  PREVIEW_SELECTOR,
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

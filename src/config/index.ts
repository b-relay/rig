/** Config module: document I/O, validation, and pure Target plan resolution. */
export * from "./types.js";
export * from "./errors.js";
export * from "./documents.js";
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
} from "./schema.js";
export { resolveTargetPlan } from "./resolve.js";
export {
  configJsonSchemas,
  renderJsonSchema,
  PROJECT_SCHEMA_URL,
  HOST_SCHEMA_URL,
  PROJECT_SCHEMA_COMMENT,
  type JsonSchema,
} from "./json-schema.js";

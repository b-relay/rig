/** Config module: document I/O, validation, and pure Target plan resolution. */
export * from "./types";
export * from "./errors";
export * from "./documents";
export {
  parseProjectConfig,
  parseHostConfig,
  projectConfigSchema,
} from "./schema";
export {
  targetOn,
  PREVIEW_SELECTOR,
  TARGET_ROLES,
  WORKING_TOOL_SUFFIX,
  type TargetRole,
} from "./target-roles";
export {
  patchedSettings,
  rolePatch,
  type ProjectSettings,
} from "./target-patch";
export { hostConfigSchema } from "./host-schema";
export { resolveTargetPlan } from "./resolve";
export {
  configJsonSchemas,
  renderJsonSchema,
  PROJECT_SCHEMA_URL,
  HOST_SCHEMA_URL,
  PROJECT_SCHEMA_COMMENT,
  type JsonSchema,
} from "./json-schema";

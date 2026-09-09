/** Config module: document I/O, validation, and pure Target plan resolution. */
export * from "./types.js";
export * from "./errors.js";
export * from "./documents.js";
export {
  parseProjectConfig,
  parseHostConfig,
  projectConfigSchema,
  hostConfigSchema,
} from "./schema.js";
export { resolveTargetPlan } from "./resolve.js";

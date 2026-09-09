/** Explicit legacy runtime metadata migration; normal commands must not invoke it implicitly. */
export { readLegacyState, migrateLegacyState } from "./files";
export { convertLegacyState } from "./convert";
export type {
  MigrationPreview,
  MigrationIssue,
  ProcessAdoption,
  RouteAdoption,
  RecoveredSource,
  MigrationReadOptions,
  MigrationWriteOptions,
} from "./types";
export {
  createAdoptionGuard,
  readLegacyAdoption,
  finalizeLegacyAdoption,
} from "./adoption";
export type { AdoptionEvidence, AdoptionManifest } from "./adoption";

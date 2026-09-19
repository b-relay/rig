/** One-time conversion of a Rig root written by the runtime before the configuration cutover. Not part of `rig` or `rigd`:
 * the runtime only refuses such a root. */
export { runCutover, type CutoverDeps } from "./command";
export {
  previewConversion,
  applyConversion,
  rollbackConversion,
  type ConversionResult,
} from "./apply";
export type { ConversionDeps, ConversionPreview } from "./inventory";
export { convertTarget, type Blocker, type TargetMapping } from "./plan";
export { projectCandidate, type ProjectCandidate } from "./project-yaml";
export { reviewSchema, type Review } from "./review";

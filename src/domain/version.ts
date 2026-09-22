/** The release number people read; bump it with each release. */
export const RIG_VERSION = "0.1.0";
/** Pure: the stamp one build reports, `<release>+<commit>`, or `<release>+dev` for a run from source. */
export const buildStamp = (
  release: string,
  commit: string | undefined,
): string => `${release}+${commit?.trim() || "dev"}`;
/** What rig and rigd report and compare. A compiled build carries the commit it was built from
 * (`bun build --define process.env.RIG_BUILD_COMMIT=...`), so two builds of one release from
 * different commits are different, and `rigd install` swaps the serving daemon on any difference
 * rather than deciding which is newer. */
export const RIG_BUILD = buildStamp(RIG_VERSION, process.env.RIG_BUILD_COMMIT);

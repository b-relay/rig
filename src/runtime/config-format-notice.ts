import { isDeprecatedFormat, LATEST_FORMAT } from "../config/formats";
import type { ConfigDocument, ProjectConfig } from "../config/types";
import type { ProjectDocuments } from "./contracts";

/** The Project documents one command reads, watched for a rig.yaml written in a deprecated format: the Project's own, or
 * the one committed on a Commit being deployed. `deprecation` is the one line that names the first such file, or undefined
 * when every file read was in the latest format. Reads are passed through unchanged. */
export function watchConfigFormats(documents: ProjectDocuments): {
  documents: ProjectDocuments;
  deprecation(): string | undefined;
} {
  let line: string | undefined;
  const seen = <T extends ConfigDocument<ProjectConfig>>(document: T): T => {
    if (
      line === undefined &&
      document.format &&
      isDeprecatedFormat(document.format)
    )
      line = deprecationLine(document.path, document.format);
    return document;
  };
  return {
    documents: {
      ...documents,
      read: async (path) => seen(await documents.read(path)),
      async discover(path) {
        const found = await documents.discover(path);
        seen(found.document);
        return found;
      },
      initialize: async (path, command) =>
        seen(await documents.initialize(path, command)),
      rename: async (project, name) =>
        seen(await documents.rename(project, name)),
    },
    deprecation: () => line,
  };
}
/** The deprecation line for one rig.yaml: which file, its format, and the command that rewrites it. */
export function deprecationLine(path: string, format: string): string {
  return `${path} is written in rig.yaml format ${format}, which is deprecated. Run rig config upgrade to rewrite it as ${LATEST_FORMAT}, then commit it.`;
}
/** A command's reply with the deprecation line added, when there is one and the reply is an object. */
export function withDeprecation<T>(reply: T, line: string | undefined): T {
  return line !== undefined &&
    typeof reply === "object" &&
    reply !== null &&
    !Array.isArray(reply)
    ? { ...reply, deprecation: line }
    : reply;
}

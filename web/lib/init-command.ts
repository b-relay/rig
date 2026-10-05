import type { RuntimeCommand } from "./types";

/** What the new-project form holds: the repository, the Project settings, and the first Service or Tool it describes. */
export interface InitFields {
  repoPath: string;
  project: string;
  productionBranch: string;
  domain: string;
  createGit: boolean;
  kind: "existing" | "service" | "tool";
  name: string;
  serviceCommand: string;
  port: string;
  healthcheck: string;
  bin: string;
  build: string;
}
/** Pure: the init command the form sends, with every empty field left out. An existing rig.yaml already decides the
 * Project settings and its Services, so they are not sent for it; sending them only earns a "not applied" warning. */
export function initCommand(
  fields: InitFields,
): RuntimeCommand & { action: "init" } {
  const fresh = fields.kind !== "existing";
  return {
    action: "init",
    repoPath: fields.repoPath,
    ...(fields.project ? { project: fields.project } : {}),
    ...(fields.productionBranch && fresh
      ? { productionBranch: fields.productionBranch }
      : {}),
    ...(fields.domain && fresh ? { domain: fields.domain } : {}),
    ...(fields.createGit ? { createGit: true } : {}),
    ...(fields.kind === "service"
      ? {
          service: {
            name: fields.name,
            command: fields.serviceCommand,
            ...(fields.port ? { port: Number(fields.port) } : {}),
            ...(fields.healthcheck ? { healthcheck: fields.healthcheck } : {}),
          },
        }
      : fields.kind === "tool"
        ? {
            tool: {
              name: fields.name,
              bin: fields.bin,
              ...(fields.build ? { build: fields.build } : {}),
            },
          }
        : {}),
  };
}

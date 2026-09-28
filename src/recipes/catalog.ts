import {
  UNDECLARED_FORMAT,
  serviceFromFormat,
  serviceIn,
  type ConfigFormat,
} from "../config/formats";
import { RECIPE_FILE_TEXT } from "./generated-files";

/** A file a recipe version writes into the Project, which the Project then owns and commits (a helper script its Service
 * runs, for example). */
export interface RecipeFile {
  /** Where it goes, relative to the Project directory (the one holding rig.yaml), with `/` separators. */
  readonly path: string;
  readonly content: string;
}
/** One released form of a recipe. `service` is the Service exactly as it would be written under `name` in a rig.yaml of
 * `format`, with every reference to itself spelled with that name. It is printed in the Project's own format. */
export interface RecipeVersion {
  readonly version: number;
  /** The rig.yaml format `service` is written in; rig/v1 when absent, as every version released before formats was. */
  readonly format?: ConfigFormat;
  service(name: string): Readonly<Record<string, unknown>>;
  /** Files `rig recipe generate` writes into the Project beside the Service; a file's content belongs to this version,
   * so a changed file is a new version. */
  readonly files?: readonly RecipeFile[];
  /** Why a Service generated from this version should move to a newer one, when that is more than an update: `rig recipe
   * generate`, `rig recipe diff`, `rig doctor` and `rig init` repeat it. One or more sentences. */
  readonly notice?: string;
}
/** A Service that Rig can write out for the user to copy. It is a starting point, not something a Project depends on. */
export interface Recipe {
  readonly name: string;
  readonly summary: string;
  /** The Service name used when the user gives none. */
  readonly defaultName: string;
  /** Oldest first; the last is the one generated and compared against. */
  readonly versions: readonly RecipeVersion[];
}
/** The recipes this build of Rig carries. Nothing is fetched: a newer recipe arrives with a newer Rig. */
export const BUNDLED_RECIPES: readonly Recipe[] = [
  {
    name: "postgres",
    summary:
      "PostgreSQL on a loopback port, with its cluster in the Service's persistent data; needs initdb, postgres and pg_isready on PATH.",
    defaultName: "db",
    versions: [
      {
        version: 1,
        format: "rig/v2",
        service: (name) => ({
          run: 'test -s "$PGDATA/PG_VERSION" || initdb -D "$PGDATA" -U postgres --auth=trust || exit $?; exec postgres -D "$PGDATA" -h "$PGHOST" -p "$PGPORT"',
          ports: { pg: "auto" },
          env: {
            PGHOST: "127.0.0.1",
            PGPORT: `\${services.${name}.ports.pg}`,
            PGDATA: "${rig.data}/pg",
          },
          health: {
            check: `pg_isready -h \${services.${name}.env.PGHOST} -p \${services.${name}.ports.pg}`,
          },
        }),
      },
    ],
  },
  {
    name: "convex",
    summary:
      "A local Convex backend on two loopback ports, with its deployment in the Service's persistent data and convex dev pushing the Project's functions to it, run by scripts/rig-convex.ts, which generate writes into the Project; needs bun and bunx on PATH, and the network or Convex's binary cache for the backend on the first start.",
    defaultName: "convex",
    versions: [
      {
        version: 1,
        format: "rig/v2",
        notice:
          "convex@1 cannot start under Rig: convex dev --local binds its backend to 0.0.0.0, so the loopback check refuses the Service (LISTENER_NONLOCAL). convex@2 runs the backend on 127.0.0.1.",
        service: (name) => ({
          run: 'exec bunx convex dev --local --local-cloud-port "$CONVEX_CLOUD_PORT" --local-site-port "$CONVEX_SITE_PORT"',
          ports: { cloud: "auto", site: "auto" },
          env: {
            CONVEX_CLOUD_PORT: `\${services.${name}.ports.cloud}`,
            CONVEX_SITE_PORT: `\${services.${name}.ports.site}`,
          },
          health: {
            check: `http://127.0.0.1:\${services.${name}.ports.cloud}/instance_name`,
            start_timeout: "60s",
          },
        }),
      },
      {
        version: 2,
        // scripts/rig-convex.ts starts the backend itself, bound to 127.0.0.1, and runs convex dev against it as a
        // self-hosted deployment. The first start may download the backend, hence the longer readiness budget. bun runs
        // it without loading .env files, so it sees only the environment Rig gives the Service.
        format: "rig/v2",
        service: (name) => ({
          run: "exec bun --no-env-file scripts/rig-convex.ts",
          ports: { cloud: "auto", site: "auto" },
          env: {
            CONVEX_CLOUD_PORT: `\${services.${name}.ports.cloud}`,
            CONVEX_SITE_PORT: `\${services.${name}.ports.site}`,
            CONVEX_STATE_DIR: "${rig.data}/backend",
          },
          health: {
            check: `http://127.0.0.1:\${services.${name}.ports.cloud}/instance_name`,
            start_timeout: "3m",
          },
        }),
        files: [
          {
            path: "scripts/rig-convex.ts",
            content: RECIPE_FILE_TEXT["rig-convex.ts"],
          },
        ],
      },
    ],
  },
];
/** The Service of one recipe version under `name`, spelled the way `format` spells it. */
export function recipeService(
  version: RecipeVersion,
  name: string,
  format: ConfigFormat,
): Record<string, unknown> {
  return serviceIn(
    format,
    serviceFromFormat(version.format ?? UNDECLARED_FORMAT, {
      ...version.service(name),
    }),
  );
}
/** The newest version of a recipe; every recipe has at least one. */
export function latest(recipe: Recipe): RecipeVersion {
  return recipe.versions.at(-1)!;
}

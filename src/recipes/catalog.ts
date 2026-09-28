import {
  UNDECLARED_FORMAT,
  serviceFromFormat,
  serviceIn,
  type ConfigFormat,
} from "../config/formats";
/** One released form of a recipe. `service` is the Service exactly as it would be written under `name` in a rig.yaml of
 * `format`, with every reference to itself spelled with that name. It is printed in the Project's own format. */
export interface RecipeVersion {
  readonly version: number;
  /** The rig.yaml format `service` is written in; rig/v1 when absent, as every version released before formats was. */
  readonly format?: ConfigFormat;
  service(name: string): Readonly<Record<string, unknown>>;
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
      "A local Convex backend on two loopback ports; needs bunx on PATH. The Convex CLI decides where its local state is kept, so it is not in the Service's persistent data.",
    defaultName: "convex",
    versions: [
      {
        version: 1,
        format: "rig/v2",
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

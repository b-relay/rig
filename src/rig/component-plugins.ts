export type RigComponentPluginId = "sqlite" | "convex" | "postgres"

export type ResolvedRigPreparedComponent =
  | {
    readonly name: string
    readonly uses: "sqlite"
    readonly path: string
  }
  | {
    readonly name: string
    readonly uses: "convex"
    readonly stateDir: string
  }
  | {
    readonly name: string
    readonly uses: "postgres"
    readonly dataDir: string
  }

export interface ResolvedRigManagedComponent {
  readonly name: string
  readonly command: string
  readonly port: number
  readonly health?: string
  readonly readyTimeout?: number
  readonly dependsOn?: readonly string[]
}

export interface RigResolvedComponentPlugin {
  readonly preparedComponents: readonly ResolvedRigPreparedComponent[]
  readonly managedComponents?: readonly ResolvedRigManagedComponent[]
  readonly properties: Readonly<Record<string, string | number>>
}

interface RigBaseComponentPluginResolveInput {
  readonly componentName: string
  readonly dataRoot: string
  readonly interpolate: (value: string) => string
}

export type RigComponentPluginResolveInput =
  | (RigBaseComponentPluginResolveInput & {
    readonly uses: "sqlite"
    readonly configuredPath?: string
  })
  | (RigBaseComponentPluginResolveInput & {
    readonly uses: "convex"
    readonly command?: string
    readonly workspacePath: string
    readonly port: number
    readonly sitePort: number
    readonly health?: string
    readonly readyTimeout?: number
    readonly dependsOn?: readonly string[]
  })
  | (RigBaseComponentPluginResolveInput & {
    readonly uses: "postgres"
    readonly command?: string
    readonly port: number
    readonly health?: string
    readonly readyTimeout?: number
    readonly dependsOn?: readonly string[]
  })

type RigSqliteComponentPluginResolveInput = Extract<RigComponentPluginResolveInput, { readonly uses: "sqlite" }>
type RigConvexComponentPluginResolveInput = Extract<RigComponentPluginResolveInput, { readonly uses: "convex" }>
type RigPostgresComponentPluginResolveInput = Extract<RigComponentPluginResolveInput, { readonly uses: "postgres" }>

interface RigComponentPluginResolver<Input extends RigComponentPluginResolveInput> {
  readonly uses: RigComponentPluginId
  readonly resolve: (input: Input) => RigResolvedComponentPlugin
}

const shellArg = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const sqlitePlugin: RigComponentPluginResolver<RigSqliteComponentPluginResolveInput> = {
  uses: "sqlite",
  resolve: (input) => {
    const path = input.interpolate(input.configuredPath ?? `${input.dataRoot}/sqlite/${input.componentName}.sqlite`)

    return {
      preparedComponents: [
        {
          name: input.componentName,
          uses: "sqlite",
          path,
        },
      ],
      properties: {
        path,
      },
    }
  },
}

const convexPlugin: RigComponentPluginResolver<RigConvexComponentPluginResolveInput> = {
  uses: "convex",
  resolve: (input) => {
    const port = input.port
    const sitePort = input.sitePort
    const stateDir = input.interpolate(`${input.workspacePath}/.convex/local/default`)
    const url = `http://127.0.0.1:${port}`
    const siteUrl = `http://127.0.0.1:${sitePort}`
    const command = input.interpolate(
      input.command ?? `bunx convex dev --local --local-cloud-port ${port} --local-site-port ${sitePort}`,
    )
    const health = input.interpolate(input.health ?? `${url}/instance_name`)

    return {
      preparedComponents: [
        {
          name: input.componentName,
          uses: "convex",
          stateDir,
        },
      ],
      managedComponents: [
        {
          name: input.componentName,
          command,
          port,
          health,
          readyTimeout: input.readyTimeout ?? 60,
          ...(input.dependsOn && input.dependsOn.length > 0 ? { dependsOn: input.dependsOn } : {}),
        },
      ],
      properties: {
        port,
        sitePort,
        stateDir,
        url,
        siteUrl,
      },
    }
  },
}

const postgresPlugin: RigComponentPluginResolver<RigPostgresComponentPluginResolveInput> = {
  uses: "postgres",
  resolve: (input) => {
    const port = input.port
    const dataDir = input.interpolate(`${input.dataRoot}/postgres/${input.componentName}`)
    const command = input.interpolate(
      input.command ??
        `sh -c 'test -f "$1/PG_VERSION" || initdb -D "$1"; exec postgres -D "$1" -h 127.0.0.1 -p "$2"' -- ${shellArg(dataDir)} ${port}`,
    )
    const health = input.interpolate(input.health ?? `pg_isready -h 127.0.0.1 -p ${port}`)

    return {
      preparedComponents: [
        {
          name: input.componentName,
          uses: "postgres",
          dataDir,
        },
      ],
      managedComponents: [
        {
          name: input.componentName,
          command,
          port,
          health,
          readyTimeout: input.readyTimeout ?? 60,
          ...(input.dependsOn && input.dependsOn.length > 0 ? { dependsOn: input.dependsOn } : {}),
        },
      ],
      properties: {
        dataDir,
        port,
      },
    }
  },
}

export const resolveRigComponentPlugin = (
  input: RigComponentPluginResolveInput,
): RigResolvedComponentPlugin =>
  input.uses === "sqlite"
    ? sqlitePlugin.resolve(input)
    : input.uses === "convex"
      ? convexPlugin.resolve(input)
      : postgresPlugin.resolve(input)

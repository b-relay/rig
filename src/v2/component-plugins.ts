export type V2ComponentPluginId = "sqlite" | "convex"

export type ResolvedV2PreparedComponent =
  | {
    readonly name: string
    readonly uses: "sqlite"
    readonly path: string
  }
  | {
    readonly name: string
    readonly uses: "convex"
    readonly dataDir: string
  }

export interface ResolvedV2ManagedComponent {
  readonly name: string
  readonly command: string
  readonly port: number
  readonly health?: string
  readonly readyTimeout?: number
  readonly dependsOn?: readonly string[]
}

export interface V2ResolvedComponentPlugin {
  readonly preparedComponents: readonly ResolvedV2PreparedComponent[]
  readonly managedComponents?: readonly ResolvedV2ManagedComponent[]
  readonly properties: Readonly<Record<string, string | number>>
}

interface V2BaseComponentPluginResolveInput {
  readonly componentName: string
  readonly dataRoot: string
  readonly interpolate: (value: string) => string
}

export type V2ComponentPluginResolveInput =
  | (V2BaseComponentPluginResolveInput & {
    readonly uses: "sqlite"
    readonly configuredPath?: string
  })
  | (V2BaseComponentPluginResolveInput & {
    readonly uses: "convex"
    readonly command?: string
    readonly port: number
    readonly health?: string
    readonly readyTimeout?: number
    readonly dependsOn?: readonly string[]
  })

type V2SqliteComponentPluginResolveInput = Extract<V2ComponentPluginResolveInput, { readonly uses: "sqlite" }>
type V2ConvexComponentPluginResolveInput = Extract<V2ComponentPluginResolveInput, { readonly uses: "convex" }>

interface V2ComponentPluginResolver<Input extends V2ComponentPluginResolveInput> {
  readonly uses: V2ComponentPluginId
  readonly resolve: (input: Input) => V2ResolvedComponentPlugin
}

const sqlitePlugin: V2ComponentPluginResolver<V2SqliteComponentPluginResolveInput> = {
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

const convexPlugin: V2ComponentPluginResolver<V2ConvexComponentPluginResolveInput> = {
  uses: "convex",
  resolve: (input) => {
    const port = input.port
    const dataDir = input.interpolate(`${input.dataRoot}/convex/${input.componentName}`)
    const url = `http://127.0.0.1:${port}`
    const command = input.interpolate(input.command ?? `bunx convex dev --host 127.0.0.1 --port ${port}`)
    const health = input.interpolate(input.health ?? `${url}/version`)

    return {
      preparedComponents: [
        {
          name: input.componentName,
          uses: "convex",
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
        url,
      },
    }
  },
}

export const resolveV2ComponentPlugin = (
  input: V2ComponentPluginResolveInput,
): V2ResolvedComponentPlugin =>
  input.uses === "sqlite" ? sqlitePlugin.resolve(input) : convexPlugin.resolve(input)

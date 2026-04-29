export type V2ComponentPluginId = "sqlite"

export interface ResolvedV2PreparedComponent {
  readonly name: string
  readonly uses: "sqlite"
  readonly path: string
}

export interface V2ResolvedComponentPlugin {
  readonly preparedComponents: readonly ResolvedV2PreparedComponent[]
  readonly properties: Readonly<Record<string, string | number>>
}

export interface V2ComponentPluginResolveInput {
  readonly uses: V2ComponentPluginId
  readonly componentName: string
  readonly dataRoot: string
  readonly configuredPath?: string
  readonly interpolate: (value: string) => string
}

interface V2ComponentPluginResolver {
  readonly uses: V2ComponentPluginId
  readonly resolve: (input: V2ComponentPluginResolveInput) => V2ResolvedComponentPlugin
}

const sqlitePlugin: V2ComponentPluginResolver = {
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

const firstPartyComponentPlugins: Readonly<Record<V2ComponentPluginId, V2ComponentPluginResolver>> = {
  sqlite: sqlitePlugin,
}

export const resolveV2ComponentPlugin = (
  input: V2ComponentPluginResolveInput,
): V2ResolvedComponentPlugin =>
  firstPartyComponentPlugins[input.uses].resolve(input)

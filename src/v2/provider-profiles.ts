import { Context, Effect, Layer } from "effect"

export type V2ProviderProfileName = "default" | "stub"

export interface V2ProviderProfile {
  readonly name: V2ProviderProfileName
  readonly processSupervisor: "rigd" | "stub"
  readonly proxyRouter: "caddy" | "stub"
  readonly scm: "local-git" | "stub"
  readonly workspaceMaterializer: "git-worktree" | "stub"
  readonly healthChecker: "native" | "stub"
}

export interface V2ProviderProfileService {
  readonly current: Effect.Effect<V2ProviderProfile>
}

export const V2ProviderProfileContext =
  Context.Service<V2ProviderProfileService>("rig/v2/V2ProviderProfile")

export const V2DefaultProviderProfile: V2ProviderProfile = {
  name: "default",
  processSupervisor: "rigd",
  proxyRouter: "caddy",
  scm: "local-git",
  workspaceMaterializer: "git-worktree",
  healthChecker: "native",
}

export const V2StubProviderProfile: V2ProviderProfile = {
  name: "stub",
  processSupervisor: "stub",
  proxyRouter: "stub",
  scm: "stub",
  workspaceMaterializer: "stub",
  healthChecker: "stub",
}

export const v2ProviderProfileFromName = (name: V2ProviderProfileName): V2ProviderProfile =>
  name === "stub" ? V2StubProviderProfile : V2DefaultProviderProfile

export const V2ProviderProfileLive = (name: V2ProviderProfileName = "default") =>
  Layer.succeed(V2ProviderProfileContext, {
    current: Effect.succeed(v2ProviderProfileFromName(name)),
  })

import { Context, Effect, Layer } from "effect"

export type RigProviderProfileName = "default" | "stub"

export interface RigProviderProfile {
  readonly name: RigProviderProfileName
  readonly processSupervisor: "rigd" | "stub"
  readonly proxyRouter: "caddy" | "stub"
  readonly scm: "local-git" | "stub"
  readonly workspaceMaterializer: "git-worktree" | "stub"
  readonly healthChecker: "native" | "stub"
}

export interface RigProviderProfileService {
  readonly current: Effect.Effect<RigProviderProfile>
}

export const RigProviderProfileContext =
  Context.Service<RigProviderProfileService>("rig/rig/RigProviderProfile")

export const RigDefaultProviderProfile: RigProviderProfile = {
  name: "default",
  processSupervisor: "rigd",
  proxyRouter: "caddy",
  scm: "local-git",
  workspaceMaterializer: "git-worktree",
  healthChecker: "native",
}

export const RigStubProviderProfile: RigProviderProfile = {
  name: "stub",
  processSupervisor: "stub",
  proxyRouter: "stub",
  scm: "stub",
  workspaceMaterializer: "stub",
  healthChecker: "stub",
}

export const rigProviderProfileFromName = (name: RigProviderProfileName): RigProviderProfile =>
  name === "stub" ? RigStubProviderProfile : RigDefaultProviderProfile

export const RigProviderProfileLive = (name: RigProviderProfileName = "default") =>
  Layer.succeed(RigProviderProfileContext, {
    current: Effect.succeed(rigProviderProfileFromName(name)),
  })

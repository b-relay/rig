import type { RigDeploymentRecord } from "./deployments.js"
import type { RigLifecycleLane } from "./lifecycle.js"
import type { RigdLogEntry, RigdWebReadModel } from "./rigd.js"
import type { RigdPersistentState } from "./rigd-state.js"

export interface RigRuntimeLogWindowInput {
  readonly project?: string
  readonly lane?: RigLifecycleLane
  readonly deployment?: string
  readonly component?: string
  readonly lines: number
  readonly includeGlobal?: boolean
}

const deploymentKindRank = (kind: RigDeploymentRecord["kind"]): number => {
  switch (kind) {
    case "local":
      return 0
    case "live":
      return 1
    case "generated":
      return 2
  }
}

const stringDetail = (
  details: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined => {
  const value = details?.[key]
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

export const deriveRigRuntimeWebReadModel = (
  state: RigdPersistentState,
): RigdWebReadModel => {
  const latestHealth = state.healthSummaries.at(-1)
  const projectNames = new Set<string>()
  const registrations = new Map<string, {
    readonly repoPaths: Set<string>
    readonly configPath?: string
    readonly productionBranch?: string
  }>()
  const projectsByRepoPath = new Map<string, Set<string>>()

  for (const snapshot of state.deploymentSnapshots) {
    projectNames.add(snapshot.project)
  }
  for (const reservation of state.portReservations) {
    projectNames.add(reservation.project)
  }
  for (const event of state.events) {
    if (event.project) {
      projectNames.add(event.project)
    }
    if (
      event.project &&
      (event.event === "rigd.project.registered" || event.event === "rigd.project.initialized")
    ) {
      const repoPath = stringDetail(event.details, "repoPath")
      const configPath = stringDetail(event.details, "configPath")
      const productionBranch = stringDetail(event.details, "productionBranch")
      const existing = registrations.get(event.project) ?? { repoPaths: new Set<string>() }
      if (repoPath) {
        existing.repoPaths.add(repoPath)
        const projects = projectsByRepoPath.get(repoPath) ?? new Set<string>()
        projects.add(event.project)
        projectsByRepoPath.set(repoPath, projects)
      }
      registrations.set(event.project, {
        repoPaths: existing.repoPaths,
        configPath: configPath ?? existing.configPath,
        productionBranch: productionBranch ?? existing.productionBranch,
      })
    }
  }

  const deployments = [...state.deploymentSnapshots]
    .sort((left, right) =>
      left.project.localeCompare(right.project) ||
      deploymentKindRank(left.kind) - deploymentKindRank(right.kind) ||
      left.deployment.localeCompare(right.deployment)
    )
    .map((snapshot) => ({
      project: snapshot.project,
      name: snapshot.deployment,
      kind: snapshot.kind,
      providerProfile: snapshot.providerProfile,
      observedAt: snapshot.observedAt,
    }))

  const targetCounts = new Map<string, number>()
  for (const deployment of deployments) {
    targetCounts.set(deployment.project, (targetCounts.get(deployment.project) ?? 0) + 1)
  }

  return {
    projects: [...projectNames].sort().map((name) => {
      const registration = registrations.get(name)
      const repoPaths = [...(registration?.repoPaths ?? [])].sort()
      const repoPath = repoPaths[0]
      const duplicatePathProjects = repoPath
        ? [...(projectsByRepoPath.get(repoPath) ?? [])].filter((project) => project !== name).sort()
        : []

      return {
        name,
        ...(repoPath ? { repoPath } : {}),
        ...(registration?.configPath ? { configPath: registration.configPath } : {}),
        ...(registration?.productionBranch ? { productionBranch: registration.productionBranch } : {}),
        targetCount: targetCounts.get(name) ?? 0,
        ...(repoPaths.length > 1 ? { duplicateIdentityPaths: repoPaths } : {}),
        ...(duplicatePathProjects.length > 0 ? { duplicatePathProjects } : {}),
      }
    }),
    deployments,
    health: {
      rigd: latestHealth
        ? {
          status: latestHealth.status,
          checkedAt: latestHealth.checkedAt,
          providerProfile: latestHealth.providerProfile,
        }
        : {
          status: "stale" as const,
        },
      deployments: state.deploymentSnapshots.map((snapshot) => ({
        project: snapshot.project,
        deployment: snapshot.deployment,
        kind: snapshot.kind,
        status: "unknown" as const,
        observedAt: snapshot.observedAt,
      })),
      components: state.portReservations.map((reservation) => ({
        project: reservation.project,
        deployment: reservation.deployment,
        component: reservation.component,
        port: reservation.port,
        status: reservation.status,
        observedAt: reservation.observedAt,
      })),
      providers: state.providerObservations.map((provider) => ({
        id: provider.id,
        family: provider.family,
        status: provider.status,
        observedAt: provider.observedAt,
      })),
    },
  }
}

export const deriveRigRuntimeLogWindow = (
  state: RigdPersistentState,
  input: RigRuntimeLogWindowInput,
): readonly RigdLogEntry[] => {
  const filtered = state.events
    .filter((entry) =>
      input.project === undefined ||
      entry.project === input.project ||
      (input.includeGlobal === true && entry.project === undefined)
    )
    .filter((entry) => input.lane === undefined || entry.lane === input.lane)
    .filter((entry) => input.deployment === undefined || entry.deployment === input.deployment)
    .filter((entry) => input.component === undefined || entry.component === input.component)

  return filtered.slice(Math.max(0, filtered.length - input.lines))
}

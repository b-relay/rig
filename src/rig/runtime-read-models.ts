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

export const deriveRigRuntimeWebReadModel = (
  state: RigdPersistentState,
): RigdWebReadModel => {
  const latestHealth = state.healthSummaries.at(-1)
  const projectNames = new Set<string>()

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

  return {
    projects: [...projectNames].sort().map((name) => ({ name })),
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

// ── Structured Error Types ──────────────────────────────────────────────────
// Every error is a tagged class with structured context + hint.
// AI agents and humans can parse these programmatically.
// All errors expose `message` (what happened) and `hint` (what to do about it).

// ── Config & Validation ─────────────────────────────────────────────────────

export interface ConfigIssue {
  readonly path: readonly (string | number)[]
  readonly message: string
  readonly code: string
}

export class ConfigValidationError {
  readonly _tag = "ConfigValidationError" as const
  constructor(
    readonly path: string,
    readonly issues: readonly ConfigIssue[],
    readonly message: string,
    readonly hint: string
  ) {}
}

// ── Version & Tagging ───────────────────────────────────────────────────────

export class VersionTagError {
  readonly _tag = "VersionTagError" as const
  constructor(
    readonly commit: string,
    readonly branch: string,
    readonly reason:
      | "uncommitted-changes"
      | "already-tagged"
      | "not-main"
      | "zero-version",
    readonly message: string,
    readonly hint: string,
    readonly details?: Record<string, unknown>
  ) {}
}

// ── Port Conflicts ──────────────────────────────────────────────────────────

export class PortConflictError {
  readonly _tag = "PortConflictError" as const
  constructor(
    readonly port: number,
    readonly service: string,
    readonly existingPid: number | null,
    readonly message: string,
    readonly hint: string
  ) {}
}

// ── Health Checks ───────────────────────────────────────────────────────────

export class HealthCheckError {
  readonly _tag = "HealthCheckError" as const
  constructor(
    readonly service: string,
    readonly check: string,
    readonly timeout: number,
    readonly lastResponse: string | null,
    readonly message: string,
    readonly hint: string
  ) {}
}

// ── Git ─────────────────────────────────────────────────────────────────────

export class MainBranchDetectionError {
  readonly _tag = "MainBranchDetectionError" as const
  constructor(
    readonly repoPath: string,
    readonly strategiesTried: readonly string[],
    readonly message: string,
    readonly hint: string
  ) {}
}

export class GitError {
  readonly _tag = "GitError" as const
  constructor(
    readonly operation: string,
    readonly repoPath: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly message: string,
    readonly hint: string
  ) {}
}

// ── File System ─────────────────────────────────────────────────────────────

export class FileSystemError {
  readonly _tag = "FileSystemError" as const
  constructor(
    readonly operation:
      | "read"
      | "write"
      | "append"
      | "copy"
      | "symlink"
      | "exists"
      | "remove"
      | "mkdir"
      | "list"
      | "chmod",
    readonly path: string,
    readonly message: string,
    readonly hint: string
  ) {}
}

// ── Process Management ──────────────────────────────────────────────────────

export class ProcessError {
  readonly _tag = "ProcessError" as const
  constructor(
    readonly operation: "spawn" | "kill" | "install" | "uninstall" | "status",
    readonly label: string,
    readonly message: string,
    readonly hint: string
  ) {}
}

// ── Reverse Proxy ───────────────────────────────────────────────────────────

export class ProxyError {
  readonly _tag = "ProxyError" as const
  constructor(
    readonly operation: "read" | "add" | "update" | "remove" | "diff" | "backup",
    readonly message: string,
    readonly hint: string
  ) {}
}

// ── Workspace ───────────────────────────────────────────────────────────────

export class WorkspaceError {
  readonly _tag = "WorkspaceError" as const
  constructor(
    readonly operation: "create" | "resolve" | "sync" | "list",
    readonly name: string,
    readonly env: string,
    readonly message: string,
    readonly hint: string
  ) {}
}

// ── Service Runner ──────────────────────────────────────────────────────────

export class ServiceRunnerError {
  readonly _tag = "ServiceRunnerError" as const
  constructor(
    readonly operation: "start" | "stop" | "health" | "logs",
    readonly service: string,
    readonly message: string,
    readonly hint: string
  ) {}
}

// ── Bin Installer ───────────────────────────────────────────────────────────

export class BinInstallerError {
  readonly _tag = "BinInstallerError" as const
  constructor(
    readonly operation: "build" | "install" | "uninstall",
    readonly name: string,
    readonly message: string,
    readonly hint: string
  ) {}
}

// ── Env Loader ──────────────────────────────────────────────────────────────

export class EnvLoaderError {
  readonly _tag = "EnvLoaderError" as const
  constructor(
    readonly envFile: string,
    readonly message: string,
    readonly hint: string
  ) {}
}

// ── Registry ────────────────────────────────────────────────────────────────

export class RegistryError {
  readonly _tag = "RegistryError" as const
  constructor(
    readonly operation: "register" | "unregister" | "resolve" | "list",
    readonly name: string,
    readonly message: string,
    readonly hint: string
  ) {}
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export class CliArgumentError {
  readonly _tag = "CliArgumentError" as const
  constructor(
    readonly command: string,
    readonly message: string,
    readonly hint: string,
    readonly details?: Record<string, unknown>
  ) {}
}

// ── Union type for Logger ───────────────────────────────────────────────────

export type RigError =
  | ConfigValidationError
  | VersionTagError
  | PortConflictError
  | HealthCheckError
  | MainBranchDetectionError
  | GitError
  | FileSystemError
  | ProcessError
  | ProxyError
  | WorkspaceError
  | ServiceRunnerError
  | BinInstallerError
  | EnvLoaderError
  | RegistryError
  | CliArgumentError

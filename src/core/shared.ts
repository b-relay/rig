import { ConfigValidationError } from "../schema/errors.js"

/** Canonical daemon label format used by lifecycle, deploy, and status. */
export const daemonLabel = (name: string, env: "dev" | "prod"): string =>
  `rig.${name}.${env}`

/** Build a single-issue ConfigValidationError with optional code and path. */
export const configError = (
  configPath: string,
  message: string,
  hint: string,
  opts?: {
    readonly code?: string
    readonly path?: readonly (string | number)[]
  },
): ConfigValidationError =>
  new ConfigValidationError(
    configPath,
    [{ path: opts?.path ?? [], message, code: opts?.code ?? "config" }],
    message,
    hint,
  )

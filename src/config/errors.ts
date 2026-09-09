/** Invalid, missing, ambiguous, stale, or unreadable user config. Context excludes config contents. */
export class ConfigError extends Error {
  readonly _tag = "ConfigError";
  constructor(
    message: string,
    readonly code: string,
    readonly context: Readonly<Record<string, unknown>> = {},
    readonly hint = "Fix the indicated config document and retry.",
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

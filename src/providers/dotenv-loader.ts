import { isAbsolute, join } from "node:path"
import { Effect, Layer } from "effect-v3"

import { EnvLoader, type EnvLoader as EnvLoaderService } from "../interfaces/env-loader.js"
import { FileSystem, type FileSystem as FileSystemService } from "../interfaces/file-system.js"
import { EnvLoaderError } from "../schema/errors.js"

const parseDotenv = (content: string, envFile: string): Readonly<Record<string, string>> => {
  const parsed: Record<string, string> = {}

  for (const [index, raw] of content.split(/\r?\n/).entries()) {
    const line = raw.trim()

    if (line.length === 0 || line.startsWith("#")) {
      continue
    }

    const value = line.replace(/^export\s+/, "")
    const separator = value.indexOf("=")

    if (separator < 0) {
      throw new EnvLoaderError(
        envFile,
        `Invalid line ${index + 1}: expected KEY=VALUE.`,
        "Fix malformed lines in the env file.",
      )
    }

    const key = value.slice(0, separator).trim()
    let entry = value.slice(separator + 1).trim()

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new EnvLoaderError(
        envFile,
        `Invalid key '${key}' on line ${index + 1}.`,
        "Use shell-compatible env var names.",
      )
    }

    if (entry.startsWith('"')) {
      if (entry.length < 2 || !entry.endsWith('"')) {
        throw new EnvLoaderError(
          envFile,
          `Unterminated double-quoted value on line ${index + 1}.`,
          "Close the value with a matching double quote.",
        )
      }

      entry = entry
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
    } else if (entry.startsWith("'")) {
      if (entry.length < 2 || !entry.endsWith("'")) {
        throw new EnvLoaderError(
          envFile,
          `Unterminated single-quoted value on line ${index + 1}.`,
          "Close the value with a matching single quote.",
        )
      }

      entry = entry.slice(1, -1)
    } else {
      entry = entry.replace(/\s+#.*$/, "").trimEnd()
    }

    parsed[key] = entry
  }

  return parsed
}

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

export class DotenvLoader implements EnvLoaderService {
  constructor(private readonly fileSystem: FileSystemService) {}

  load(envFile: string, workdir: string): Effect.Effect<Readonly<Record<string, string>>, EnvLoaderError> {
    const path = isAbsolute(envFile) ? envFile : join(workdir, envFile)

    return this.fileSystem.read(path).pipe(
      Effect.mapError((error) =>
        new EnvLoaderError(
          path,
          causeMessage(error),
          `Ensure ${path} exists and is readable.`,
        )),
      Effect.flatMap((content) =>
        Effect.try({
          try: () => parseDotenv(content, path),
          catch: (cause) =>
            cause instanceof EnvLoaderError
              ? cause
              : new EnvLoaderError(path, causeMessage(cause), "Fix syntax issues in the env file."),
        }),
      ),
    )
  }
}

export const DotenvLoaderLive = Layer.effect(
  EnvLoader,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    return new DotenvLoader(fileSystem)
  }),
)

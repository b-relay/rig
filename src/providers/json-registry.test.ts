import { dirname } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import type { FileSystem as FileSystemService } from "../interfaces/file-system.js"
import { FileSystemError, RegistryError } from "../schema/errors.js"
import { JSONRegistry } from "./json-registry.js"

const REGISTRY_PATH = "/tmp/.rig/registry.json"

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)
const runEither = <A, E>(effect: Effect.Effect<A, E>) => run(effect.pipe(Effect.either))

class InMemoryFileSystem implements FileSystemService {
  readonly files = new Map<string, string>()
  readonly dirs = new Set<string>()
  readonly symlinks = new Map<string, string>()

  read(path: string) {
    const content = this.files.get(path)
    if (content === undefined) {
      return Effect.fail(new FileSystemError("read", path, "ENOENT", "File not found."))
    }
    return Effect.succeed(content)
  }

  write(path: string, content: string) {
    this.files.set(path, content)
    return Effect.void
  }

  copy(src: string, dest: string) {
    const content = this.files.get(src)
    if (content === undefined) {
      return Effect.fail(new FileSystemError("copy", src, "ENOENT", "Source not found."))
    }
    this.files.set(dest, content)
    return Effect.void
  }

  symlink(target: string, link: string) {
    this.symlinks.set(link, target)
    return Effect.void
  }

  exists(path: string) {
    return Effect.succeed(this.files.has(path) || this.dirs.has(path) || this.symlinks.has(path))
  }

  remove(path: string) {
    return Effect.sync(() => {
      this.files.delete(path)
      this.dirs.delete(path)
      this.symlinks.delete(path)
    })
  }

  mkdir(path: string) {
    return Effect.sync(() => {
      this.dirs.add(path)
    })
  }

  list(path: string) {
    const entries = new Set<string>()
    const roots = [...this.files.keys(), ...this.dirs.values(), ...this.symlinks.keys()]

    for (const candidate of roots) {
      if (!candidate.startsWith(path + "/")) {
        continue
      }
      const relative = candidate.slice(path.length + 1)
      if (!relative || relative.includes("/")) {
        continue
      }
      entries.add(relative)
    }

    return Effect.succeed([...entries])
  }

  chmod(_path: string, _mode: number) {
    return Effect.void
  }
}

const createSubject = () => {
  const fileSystem = new InMemoryFileSystem()
  const registry = new JSONRegistry(fileSystem, REGISTRY_PATH)
  return { fileSystem, registry }
}

const readCanonicalRegistry = (
  fileSystem: InMemoryFileSystem,
): Record<string, { readonly repoPath: string; readonly registeredAt: string }> => {
  const raw = fileSystem.files.get(REGISTRY_PATH)
  if (!raw) {
    throw new Error("registry file missing")
  }
  return JSON.parse(raw) as Record<string, { readonly repoPath: string; readonly registeredAt: string }>
}

describe("JSONRegistry", () => {
  describe("register", () => {
    test("registers a new project", async () => {
      const { fileSystem, registry } = createSubject()

      await run(registry.register("pantry", "/repos/pantry"))

      const listed = await run(registry.list())
      expect(listed).toHaveLength(1)
      expect(listed[0].name).toBe("pantry")
      expect(listed[0].repoPath).toBe("/repos/pantry")

      const raw = readCanonicalRegistry(fileSystem)
      expect(raw.pantry.repoPath).toBe("/repos/pantry")
      expect(typeof raw.pantry.registeredAt).toBe("string")
    })

    test("overwrites an existing project and updates registeredAt", async () => {
      const { fileSystem, registry } = createSubject()
      const oldDate = "2000-01-01T00:00:00.000Z"
      fileSystem.files.set(
        REGISTRY_PATH,
        `${JSON.stringify({ pantry: { repoPath: "/repos/old", registeredAt: oldDate } }, null, 2)}\n`,
      )

      await run(registry.register("pantry", "/repos/new"))

      const raw = readCanonicalRegistry(fileSystem)
      expect(raw.pantry.repoPath).toBe("/repos/new")
      expect(raw.pantry.registeredAt).not.toBe(oldDate)
      expect(new Date(raw.pantry.registeredAt).getTime()).toBeGreaterThan(new Date(oldDate).getTime())
    })

    test("rejects project names with special characters", async () => {
      const { registry } = createSubject()

      const result = await runEither(registry.register("Pantry/Prod", "/repos/pantry"))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(RegistryError)
        expect(result.left.operation).toBe("register")
        expect(result.left.message).toContain("lowercase alphanumeric with hyphens only")
      }
    })

    test("rejects empty project name", async () => {
      const { registry } = createSubject()

      const result = await runEither(registry.register("", "/repos/pantry"))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(RegistryError)
        expect(result.left.operation).toBe("register")
      }
    })

    test("rejects empty repoPath", async () => {
      const { registry } = createSubject()

      const result = await runEither(registry.register("pantry", "   "))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(RegistryError)
        expect(result.left.message).toContain("non-empty string")
      }
    })
  })

  describe("unregister", () => {
    test("removes an existing project", async () => {
      const { registry } = createSubject()

      await run(registry.register("pantry", "/repos/pantry"))
      await run(registry.unregister("pantry"))

      const resolved = await runEither(registry.resolve("pantry"))
      expect(resolved._tag).toBe("Left")
    })

    test("succeeds for a non-existent project (idempotent)", async () => {
      const { fileSystem, registry } = createSubject()

      await run(registry.unregister("ghost"))
      const listed = await run(registry.list())

      expect(listed).toEqual([])
      expect(readCanonicalRegistry(fileSystem)).toEqual({})
    })
  })

  describe("resolve", () => {
    test("returns repo path for a registered project", async () => {
      const { registry } = createSubject()

      await run(registry.register("pantry", "/repos/pantry"))
      const path = await run(registry.resolve("pantry"))

      expect(path).toBe("/repos/pantry")
    })

    test("fails with RegistryError for unregistered project", async () => {
      const { registry } = createSubject()

      const result = await runEither(registry.resolve("missing"))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(RegistryError)
        expect(result.left.operation).toBe("resolve")
        expect(result.left.message).toContain("not registered")
      }
    })
  })

  describe("list", () => {
    test("returns empty registry", async () => {
      const { registry } = createSubject()

      const listed = await run(registry.list())
      expect(listed).toEqual([])
    })

    test("returns entries sorted by name", async () => {
      const { registry } = createSubject()

      await run(registry.register("zeta", "/repos/zeta"))
      await run(registry.register("alpha", "/repos/alpha"))
      await run(registry.register("middle", "/repos/middle"))

      const listed = await run(registry.list())
      expect(listed.map((entry) => entry.name)).toEqual(["alpha", "middle", "zeta"])
    })

    test("normalizes legacy string-format entries", async () => {
      const { fileSystem, registry } = createSubject()
      fileSystem.files.set(REGISTRY_PATH, `${JSON.stringify({ legacy: "/repos/legacy" }, null, 2)}\n`)

      const listed = await run(registry.list())

      expect(listed).toHaveLength(1)
      expect(listed[0].name).toBe("legacy")
      expect(listed[0].repoPath).toBe("/repos/legacy")
      expect(listed[0].registeredAt.toISOString()).toBe("1970-01-01T00:00:00.000Z")
    })
  })

  describe("readRegistry edge cases", () => {
    test("auto-creates missing registry file", async () => {
      const { fileSystem, registry } = createSubject()

      const listed = await run(registry.list())
      expect(listed).toEqual([])
      expect(fileSystem.files.get(REGISTRY_PATH)).toBe("{}\n")
      expect(fileSystem.dirs.has(dirname(REGISTRY_PATH))).toBe(true)
    })

    test("fails with clear error on invalid JSON", async () => {
      const { fileSystem, registry } = createSubject()
      fileSystem.files.set(REGISTRY_PATH, "{ invalid json\n")

      const result = await runEither(registry.list())
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(RegistryError)
        expect(result.left.hint).toContain(`Fix invalid JSON in ${REGISTRY_PATH}.`)
      }
    })

    test("fails when JSON root is not an object", async () => {
      const { fileSystem, registry } = createSubject()
      fileSystem.files.set(REGISTRY_PATH, `${JSON.stringify(["bad-root"], null, 2)}\n`)

      const result = await runEither(registry.list())
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(RegistryError)
        expect(result.left.message).toContain("Registry must be a JSON object")
      }
    })

    test("fails for malformed entry missing repoPath", async () => {
      const { fileSystem, registry } = createSubject()
      fileSystem.files.set(
        REGISTRY_PATH,
        `${JSON.stringify({ pantry: { registeredAt: "2024-01-01T00:00:00.000Z" } }, null, 2)}\n`,
      )

      const result = await runEither(registry.list())
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(RegistryError)
        expect(result.left.message).toContain("must be a string or { repoPath, registeredAt } object")
      }
    })
  })

  test("concurrent-ish writes: sequential register calls keep both entries", async () => {
    const { registry } = createSubject()

    await run(registry.register("web", "/repos/web"))
    await run(registry.register("api", "/repos/api"))

    const webPath = await run(registry.resolve("web"))
    const apiPath = await run(registry.resolve("api"))
    const listed = await run(registry.list())

    expect(webPath).toBe("/repos/web")
    expect(apiPath).toBe("/repos/api")
    expect(listed.map((entry) => entry.name)).toEqual(["api", "web"])
  })
})

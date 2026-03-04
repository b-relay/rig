import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { CaddyProxy } from "./caddy.js"
import { ProxyError } from "../schema/errors.js"
import type { ProxyEntry } from "../interfaces/reverse-proxy.js"

const MANUAL_BLOCK = `# Manual Caddy config
example.com {
\treverse_proxy http://127.0.0.1:9000
}
`

const RIG_BLOCK_PANTRY_PROD = `# [rig:pantry:prod:web]
pantry.b-relay.com {
\treverse_proxy http://127.0.0.1:3070
\timport cloudflare
\timport backend_errors
}`

const RIG_BLOCK_PANTRY_DEV = `# [rig:pantry:dev:web]
dev.pantry.b-relay.com {
\treverse_proxy http://127.0.0.1:5173
\timport cloudflare
\timport backend_errors
}`

const RIG_BLOCK_WITH_PLACEHOLDER = `# [rig:placeholder:prod:web]
placeholder.b-relay.com {
\treverse_proxy http://127.0.0.1:3080
\tmap {http.request.host} {backend} {
\t\tdefault web
\t}
\timport cloudflare
\timport backend_errors
}`

const MIXED_CADDYFILE = [MANUAL_BLOCK, RIG_BLOCK_PANTRY_PROD, "", RIG_BLOCK_PANTRY_DEV, ""].join("\n")

let tmpDir: string
let caddyfilePath: string
let caddy: CaddyProxy

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "rig-caddy-test-"))
  caddyfilePath = join(tmpDir, "Caddyfile")
  caddy = new CaddyProxy(caddyfilePath)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

describe("CaddyProxy", () => {
  test("read() parses rig-managed entries from a mixed Caddyfile", async () => {
    await writeFile(caddyfilePath, MIXED_CADDYFILE)

    const entries = await run(caddy.read())

    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      name: "pantry",
      env: "prod",
      domain: "pantry.b-relay.com",
      upstream: "web",
      port: 3070,
    })
    expect(entries[1]).toEqual({
      name: "pantry",
      env: "dev",
      domain: "dev.pantry.b-relay.com",
      upstream: "web",
      port: 5173,
    })
  })

  test("read() returns empty array when Caddyfile does not exist", async () => {
    const entries = await run(caddy.read())
    expect(entries).toEqual([])
  })

  test("read() ignores manual blocks", async () => {
    await writeFile(caddyfilePath, MANUAL_BLOCK)

    const entries = await run(caddy.read())
    expect(entries).toEqual([])
  })

  test("add() appends a new rig block without disturbing manual blocks", async () => {
    await writeFile(caddyfilePath, MANUAL_BLOCK)

    const entry: ProxyEntry = {
      name: "api",
      env: "prod",
      domain: "api.b-relay.com",
      upstream: "api",
      port: 4000,
    }

    const change = await run(caddy.add(entry))
    expect(change.type).toBe("added")
    expect(change.entry).toEqual(entry)

    // Verify manual block is untouched
    const content = await readFile(caddyfilePath, "utf-8")
    expect(content).toContain("example.com {")
    expect(content).toContain("# [rig:api:prod:api]")
    expect(content).toContain("api.b-relay.com {")
    expect(content).toContain("reverse_proxy http://127.0.0.1:4000")
  })

  test("add() creates Caddyfile if it does not exist", async () => {
    const entry: ProxyEntry = {
      name: "web",
      env: "dev",
      domain: "dev.web.b-relay.com",
      upstream: "web",
      port: 3000,
    }

    await run(caddy.add(entry))

    const content = await readFile(caddyfilePath, "utf-8")
    expect(content).toContain("# [rig:web:dev:web]")
    expect(content).toContain("dev.web.b-relay.com {")
  })

  test("add() fails if entry already exists", async () => {
    await writeFile(caddyfilePath, MIXED_CADDYFILE)

    const entry: ProxyEntry = {
      name: "pantry",
      env: "prod",
      domain: "pantry.b-relay.com",
      upstream: "web",
      port: 3070,
    }

    const result = await Effect.runPromiseExit(caddy.add(entry))
    expect(result._tag).toBe("Failure")
  })

  test("update() modifies an existing rig block", async () => {
    await writeFile(caddyfilePath, MIXED_CADDYFILE)

    const entry: ProxyEntry = {
      name: "pantry",
      env: "prod",
      domain: "pantry.b-relay.com",
      upstream: "web",
      port: 8080, // changed port
    }

    const change = await run(caddy.update(entry))
    expect(change.type).toBe("updated")
    expect(change.entry.port).toBe(8080)

    // Verify the file was updated
    const content = await readFile(caddyfilePath, "utf-8")
    expect(content).toContain("reverse_proxy http://127.0.0.1:8080")
    expect(content).not.toContain("reverse_proxy http://127.0.0.1:3070")

    // Manual block still there
    expect(content).toContain("example.com {")

    // Dev block still there
    expect(content).toContain("# [rig:pantry:dev:web]")
    expect(content).toContain("reverse_proxy http://127.0.0.1:5173")
  })

  test("update() fails if entry does not exist", async () => {
    await writeFile(caddyfilePath, MANUAL_BLOCK)

    const entry: ProxyEntry = {
      name: "ghost",
      env: "prod",
      domain: "ghost.b-relay.com",
      upstream: "ghost",
      port: 9999,
    }

    const result = await Effect.runPromiseExit(caddy.update(entry))
    expect(result._tag).toBe("Failure")
  })

  test("remove() removes a rig block without disturbing other content", async () => {
    await writeFile(caddyfilePath, MIXED_CADDYFILE)

    const change = await run(caddy.remove("pantry", "prod"))
    expect(change.type).toBe("removed")
    expect(change.entry.name).toBe("pantry")
    expect(change.entry.env).toBe("prod")

    const content = await readFile(caddyfilePath, "utf-8")
    expect(content).not.toContain("# [rig:pantry:prod:")
    expect(content).not.toMatch(/^pantry\.b-relay\.com \{/m)

    // Manual block and dev block still there
    expect(content).toContain("example.com {")
    expect(content).toContain("# [rig:pantry:dev:web]")
  })

  test("remove() succeeds if entry does not exist", async () => {
    await writeFile(caddyfilePath, MANUAL_BLOCK)

    const change = await run(caddy.remove("ghost", "prod"))
    expect(change).toEqual({
      type: "removed",
      entry: {
        name: "ghost",
        env: "prod",
        domain: "",
        upstream: "",
        port: 0,
      },
    })
  })

  test("read() correctly handles Caddy placeholder braces", async () => {
    await writeFile(caddyfilePath, `${RIG_BLOCK_WITH_PLACEHOLDER}\n`)

    const entries = await run(caddy.read())
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      name: "placeholder",
      env: "prod",
      domain: "placeholder.b-relay.com",
      upstream: "web",
      port: 3080,
    })
  })

  test("remove() handles placeholder braces when locating block end", async () => {
    await writeFile(caddyfilePath, `${RIG_BLOCK_WITH_PLACEHOLDER}\n`)

    const change = await run(caddy.remove("placeholder", "prod"))
    expect(change.type).toBe("removed")

    const content = await readFile(caddyfilePath, "utf-8")
    expect(content.trim()).toBe("")
  })

  test("backup() creates a timestamped copy", async () => {
    await writeFile(caddyfilePath, MIXED_CADDYFILE)

    const backupPath = await run(caddy.backup())

    expect(backupPath).toContain("Caddyfile.backup-")
    const backupContent = await readFile(backupPath, "utf-8")
    expect(backupContent).toBe(MIXED_CADDYFILE)
  })

  test("add() backs up Caddyfile before writing", async () => {
    await writeFile(caddyfilePath, MANUAL_BLOCK)

    const entry: ProxyEntry = {
      name: "web",
      env: "prod",
      domain: "web.b-relay.com",
      upstream: "web",
      port: 3000,
    }

    await run(caddy.add(entry))

    const backupFiles = (await readdir(tmpDir)).filter((file) => file.startsWith("Caddyfile.backup-"))
    expect(backupFiles).toHaveLength(1)

    const backupContent = await readFile(join(tmpDir, backupFiles[0]), "utf-8")
    expect(backupContent).toBe(MANUAL_BLOCK)
  })

  test("update() backs up Caddyfile before writing", async () => {
    await writeFile(caddyfilePath, MIXED_CADDYFILE)

    const entry: ProxyEntry = {
      name: "pantry",
      env: "prod",
      domain: "pantry.b-relay.com",
      upstream: "web",
      port: 8080,
    }

    await run(caddy.update(entry))

    const backupFiles = (await readdir(tmpDir)).filter((file) => file.startsWith("Caddyfile.backup-"))
    expect(backupFiles).toHaveLength(1)

    const backupContent = await readFile(join(tmpDir, backupFiles[0]), "utf-8")
    expect(backupContent).toContain("reverse_proxy http://127.0.0.1:3070")
    expect(backupContent).not.toContain("reverse_proxy http://127.0.0.1:8080")
  })

  test("remove() backs up Caddyfile before writing", async () => {
    await writeFile(caddyfilePath, MIXED_CADDYFILE)

    await run(caddy.remove("pantry", "prod"))

    const backupFiles = (await readdir(tmpDir)).filter((file) => file.startsWith("Caddyfile.backup-"))
    expect(backupFiles).toHaveLength(1)

    const backupContent = await readFile(join(tmpDir, backupFiles[0]), "utf-8")
    expect(backupContent).toContain("# [rig:pantry:prod:web]")
  })

  test("round-trip: add then read returns the entry", async () => {
    const entry: ProxyEntry = {
      name: "myapp",
      env: "prod",
      domain: "myapp.b-relay.com",
      upstream: "myapp",
      port: 7777,
    }

    await run(caddy.add(entry))
    const entries = await run(caddy.read())

    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual(entry)
  })
})

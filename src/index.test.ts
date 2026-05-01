import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const runRigCommand = async (
  argv: readonly string[],
  env: Record<string, string>,
  options: {
    readonly cwd?: string
  } = {},
) => {
  const processHandle = Bun.spawn({
    cmd: [process.execPath, "run", join(process.cwd(), "src/index.ts"), ...argv],
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    processHandle.stdout ? new Response(processHandle.stdout).text() : Promise.resolve(""),
    processHandle.stderr ? new Response(processHandle.stderr).text() : Promise.resolve(""),
    processHandle.exited,
  ])

  return { stdout, stderr, exitCode }
}

describe("GIVEN rig entrypoint WHEN executed directly THEN behavior is covered", () => {
  test("GIVEN main help WHEN run directly THEN it identifies the final rig CLI", async () => {
    const { stdout, stderr, exitCode } = await runRigCommand(["--help"], {})

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("rig")
  })

  test("GIVEN init command WHEN run directly THEN it writes rig project files and registers the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig-repo-"))

    try {
      await writeFile(
        join(repo, "package.json"),
        `${JSON.stringify({
          name: "pantry",
          scripts: {
            test: "bun test",
          },
        }, null, 2)}\n`,
        "utf8",
      )

      const init = await runRigCommand(
        [
          "init",
          "--project",
          "pantry",
          "--path",
          repo,
          "--state-root",
          root,
          "--provider-profile",
          "stub",
          "--domain",
          "pantry.b-relay.com",
          "--proxy",
          "web",
          "--package-scripts",
          "--uses",
          "sqlite,postgres,convex",
        ],
        { RIG_ROOT: root },
      )

      expect(init.exitCode).toBe(0)
      expect(init.stderr).toBe("")
      expect(init.stdout).toContain("[INFO] rig project initialized")
      expect(init.stdout).toContain('"project":"pantry"')

      const rigConfig = JSON.parse(await readFile(join(repo, "rig.json"), "utf8")) as {
        readonly name?: string
        readonly domain?: string
        readonly components?: Record<string, unknown>
        readonly local?: { readonly providerProfile?: string; readonly proxy?: { readonly upstream?: string } }
        readonly live?: { readonly providerProfile?: string; readonly proxy?: { readonly upstream?: string } }
        readonly deployments?: {
          readonly subdomain?: string
          readonly providerProfile?: string
          readonly proxy?: { readonly upstream?: string }
        }
      }
      expect(rigConfig).toMatchObject({
        name: "pantry",
        domain: "pantry.b-relay.com",
        components: {
          sqlite: { uses: "sqlite" },
          postgres: { uses: "postgres" },
          convex: { uses: "convex" },
        },
        local: { providerProfile: "stub", proxy: { upstream: "web" } },
        live: { providerProfile: "stub", proxy: { upstream: "web" } },
        deployments: {
          subdomain: "${branchSlug}",
          providerProfile: "stub",
          proxy: { upstream: "web" },
        },
      })

      const packageJson = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as {
        readonly scripts?: Record<string, string>
      }
      expect(packageJson.scripts?.test).toBe("bun test")
      expect(packageJson.scripts?.["rig:up"]).toBe("rig up")
      expect(packageJson.scripts?.["rig:restart"]).toBe("rig restart")
      expect(packageJson.scripts?.["rig:list"]).toBe("rig list")

      const list = await runRigCommand(["list", "--state-root", root], { RIG_ROOT: root })

      expect(list.exitCode).toBe(0)
      expect(list.stderr).toBe("")
      expect(list.stdout).toContain("[INFO] rig projects")
      expect(list.stdout).toContain("projects:\n  pantry")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("GIVEN status command WHEN run through src/index.ts THEN it uses the isolated rig root", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))

    try {
      const { stdout, stderr, exitCode } = await runRigCommand(
        ["status", "--project", "pantry"],
        { RIG_ROOT: root },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("[INFO] rig foundation ready")
      expect(stdout).toContain("[INFO] rigd status")
      expect(stdout).toContain(`state root: ${root}`)
      expect(stdout).toContain("namespace: rig.pantry")
      expect(stdout).toContain("launchd label prefix: com.b-relay.rig")
      expect(stdout).toContain("rigd: running")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN up command without project WHEN run from repo THEN it infers current project", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig-repo-"))

    try {
      await writeFile(
        join(repo, "rig.json"),
        `${JSON.stringify({
          name: "rig",
          components: {
            web: {
              mode: "managed",
              command: "printf 'started\\n'",
              port: 3070,
            },
          },
          deployments: {
            providerProfile: "stub",
          },
        }, null, 2)}\n`,
        "utf8",
      )

      const { stdout, stderr, exitCode } = await runRigCommand(
        ["up", "--state-root", root],
        { RIG_ROOT: root },
        { cwd: repo },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("[INFO] rig lifecycle accepted")
      expect(stdout).toContain('"project":"rig"')
      expect(stdout).toContain('"target":"local"')
      expect(stdout).toContain(`"stateRoot":"${root}"`)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("GIVEN a fake project initialized by rig WHEN web component is added THEN local live and generated deploys accept the config", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig-fake-project-"))
    const configPath = join(repo, "rig.json")

    try {
      const init = await runRigCommand(
        [
          "init",
          "--project",
          "fake-fullstack",
          "--path",
          repo,
          "--state-root",
          root,
          "--provider-profile",
          "stub",
          "--domain",
          "fake-fullstack.example.test",
          "--proxy",
          "web",
          "--uses",
          "sqlite",
        ],
        { RIG_ROOT: root },
      )

      expect(init.exitCode).toBe(0)
      expect(init.stderr).toBe("")

      const addWeb = await runRigCommand(
        [
          "config",
          "set",
          "--path",
          "components.web",
          "--json",
          JSON.stringify({
            mode: "managed",
            command: "printf 'fake web started on ${web.port}\\n'",
          }),
          "--apply",
        ],
        { RIG_ROOT: root },
        { cwd: repo },
      )

      expect(addWeb.exitCode).toBe(0)
      expect(addWeb.stderr).toBe("")
      expect(addWeb.stdout).toContain("[INFO] rig config applied")

      const up = await runRigCommand(
        ["up", "--state-root", root],
        { RIG_ROOT: root },
        { cwd: repo },
      )

      expect(up.exitCode).toBe(0)
      expect(up.stderr).toBe("")
      expect(up.stdout).toContain("[INFO] rig lifecycle accepted")
      expect(up.stdout).toContain('"project":"fake-fullstack"')
      expect(up.stdout).toContain('"target":"local"')

      const deploy = await runRigCommand(
        ["deploy", "--state-root", root, "--ref", "main"],
        { RIG_ROOT: root },
        { cwd: repo },
      )

      expect(deploy.exitCode).toBe(0)
      expect(deploy.stderr).toBe("")
      expect(deploy.stdout).toContain("[INFO] rig deploy accepted")
      expect(deploy.stdout).toContain('"project":"fake-fullstack"')
      expect(deploy.stdout).toContain('"target":"live"')

      const generatedDeploy = await runRigCommand(
        ["deploy", "--state-root", root, "--target", "generated", "--ref", "feature/test"],
        { RIG_ROOT: root },
        { cwd: repo },
      )

      expect(generatedDeploy.exitCode).toBe(0)
      expect(generatedDeploy.stderr).toBe("")
      expect(generatedDeploy.stdout).toContain("[INFO] rig deploy accepted")
      expect(generatedDeploy.stdout).toContain('"project":"fake-fullstack"')
      expect(generatedDeploy.stdout).toContain('"target":"generated:feature-test"')

      const list = await runRigCommand(
        ["list", "--state-root", root, "--json"],
        { RIG_ROOT: root },
        { cwd: repo },
      )

      expect(list.exitCode).toBe(0)
      expect(list.stderr).toBe("")
      expect(list.stdout).toContain("fake-fullstack/feature-test (generated) profile=stub")
      expect(list.stdout).toContain('"name":"feature-test"')
      expect(list.stdout).toContain('"kind":"generated"')
      expect(list.stdout).toContain('"deployment":"feature-test"')
      expect(list.stdout).toContain('"component":"web"')
      expect(list.stdout).toContain('"status":"reserved"')

      const logs = await runRigCommand(
        ["logs", "--state-root", root, "--lines", "100"],
        { RIG_ROOT: root },
        { cwd: repo },
      )

      expect(logs.exitCode).toBe(0)
      expect(logs.stderr).toBe("")
      expect(logs.stdout).toContain('"deployment":"feature-test"')
      expect(logs.stdout).toContain('"component":"sqlite"')
      expect(logs.stdout).toContain(`/data/fake-fullstack/deployments/feature-test/sqlite/sqlite.sqlite`)

      const rigConfig = JSON.parse(await readFile(configPath, "utf8")) as {
        readonly components?: Record<string, unknown>
        readonly local?: { readonly proxy?: { readonly upstream?: string } }
      }
      expect(rigConfig.components).toMatchObject({
        sqlite: { uses: "sqlite" },
        web: {
          mode: "managed",
          command: "printf 'fake web started on ${web.port}\\n'",
        },
      })
      expect(rigConfig.local?.proxy?.upstream).toBe("web")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("GIVEN a Pantry-like fake app WHEN web sqlite and CLI components are configured THEN rig deploys the app shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig-pantry-like-"))
    const configPath = join(repo, "rig.json")

    try {
      const init = await runRigCommand(
        [
          "init",
          "--project",
          "pantry-like",
          "--path",
          repo,
          "--state-root",
          root,
          "--provider-profile",
          "stub",
          "--domain",
          "pantry-like.example.test",
          "--proxy",
          "web",
          "--uses",
          "sqlite",
        ],
        { RIG_ROOT: root },
      )

      expect(init.exitCode).toBe(0)
      expect(init.stderr).toBe("")

      const addWeb = await runRigCommand(
        [
          "config",
          "set",
          "--path",
          "components.web",
          "--json",
          JSON.stringify({
            mode: "managed",
            command: "printf 'pantry-like web on ${web.port} using ${sqlite.path}\\n'",
          }),
          "--apply",
        ],
        { RIG_ROOT: root },
        { cwd: repo },
      )

      expect(addWeb.exitCode).toBe(0)
      expect(addWeb.stderr).toBe("")

      const addCli = await runRigCommand(
        [
          "config",
          "set",
          "--path",
          "components.cli",
          "--json",
          JSON.stringify({
            mode: "installed",
            entrypoint: "dist/pantry",
            build: "mkdir -p dist && printf '#!/bin/sh\\necho pantry-like:$1\\n' > dist/pantry",
            installName: "pantry",
          }),
          "--apply",
        ],
        { RIG_ROOT: root },
        { cwd: repo },
      )

      expect(addCli.exitCode).toBe(0)
      expect(addCli.stderr).toBe("")

      const liveDeploy = await runRigCommand(
        ["deploy", "--state-root", root, "--ref", "main"],
        { RIG_ROOT: root },
        { cwd: repo },
      )

      expect(liveDeploy.exitCode).toBe(0)
      expect(liveDeploy.stderr).toBe("")
      expect(liveDeploy.stdout).toContain("[INFO] rig deploy accepted")
      expect(liveDeploy.stdout).toContain('"project":"pantry-like"')
      expect(liveDeploy.stdout).toContain('"target":"live"')

      const generatedDeploy = await runRigCommand(
        ["deploy", "--state-root", root, "--target", "generated", "--ref", "feature/pantry-like-preview"],
        { RIG_ROOT: root },
        { cwd: repo },
      )

      expect(generatedDeploy.exitCode).toBe(0)
      expect(generatedDeploy.stderr).toBe("")
      expect(generatedDeploy.stdout).toContain('"target":"generated:feature-pantry-like-preview"')

      const list = await runRigCommand(
        ["list", "--state-root", root, "--json"],
        { RIG_ROOT: root },
        { cwd: repo },
      )

      expect(list.exitCode).toBe(0)
      expect(list.stderr).toBe("")
      expect(list.stdout).toContain("pantry-like/live (live) profile=stub")
      expect(list.stdout).toContain("pantry-like/feature-pantry-like-preview (generated) profile=stub")
      expect(list.stdout).toContain('"component":"web"')

      const logs = await runRigCommand(
        ["logs", "--state-root", root, "--lines", "200"],
        { RIG_ROOT: root },
        { cwd: repo },
      )

      expect(logs.exitCode).toBe(0)
      expect(logs.stderr).toBe("")
      expect(logs.stdout).toContain('"component":"sqlite"')
      expect(logs.stdout).toContain('"component":"pantry"')
      expect(logs.stdout).toContain('"event":"component.install"')
      expect(logs.stdout).toContain("/data/pantry-like/live/sqlite/sqlite.sqlite")
      expect(logs.stdout).toContain("/data/pantry-like/deployments/feature-pantry-like-preview/sqlite/sqlite.sqlite")

      const rigConfig = JSON.parse(await readFile(configPath, "utf8")) as {
        readonly components?: Record<string, unknown>
        readonly domain?: string
        readonly live?: { readonly proxy?: { readonly upstream?: string } }
      }
      expect(rigConfig.domain).toBe("pantry-like.example.test")
      expect(rigConfig.live?.proxy?.upstream).toBe("web")
      expect(rigConfig.components).toMatchObject({
        sqlite: { uses: "sqlite" },
        web: {
          mode: "managed",
          command: "printf 'pantry-like web on ${web.port} using ${sqlite.path}\\n'",
        },
        cli: {
          mode: "installed",
          entrypoint: "dist/pantry",
          installName: "pantry",
        },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("GIVEN rigd command WHEN run directly THEN it starts the local MVP API", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))

    try {
      const { stdout, stderr, exitCode } = await runRigCommand(
        ["rigd", "--state-root", root],
        { RIG_ROOT: root },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("[INFO] rigd local API ready")
      expect(stdout).toContain('"service":"rigd"')
      expect(stdout).toContain('"transport":"localhost-http"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN deploy command WHEN run directly THEN it emits a ref-based deploy intent", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))

    try {
      const { stdout, stderr, exitCode } = await runRigCommand(
        ["deploy", "--project", "pantry", "--state-root", root, "--ref", "feature/preview", "--target", "generated"],
        { RIG_ROOT: root },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("[INFO] rig deploy intent")
      expect(stdout).toContain('"ref":"feature/preview"')
      expect(stdout).toContain('"target":"generated"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN bump command WHEN run directly THEN it emits optional version metadata", async () => {
    const { stdout, stderr, exitCode } = await runRigCommand(
      ["bump", "--project", "pantry", "--current", "1.2.3", "--bump", "patch"],
      {},
    )

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("[INFO] rig bump metadata")
    expect(stdout).toContain('"nextVersion":"1.2.4"')
    expect(stdout).toContain('"rollbackAnchor":"v1.2.3"')
  })

  test("GIVEN doctor command WHEN run directly THEN it emits reliability categories", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))

    try {
      const { stdout, stderr, exitCode } = await runRigCommand(
        ["doctor", "--project", "pantry", "--state-root", root],
        { RIG_ROOT: root },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("[INFO] rig doctor report")
      expect(stdout).toContain('"category":"path"')
      expect(stdout).toContain('"category":"providers"')
      expect(stdout).toContain('"name":"localhost-http"')
      expect(stdout).toContain('"family":"control-plane-transport"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN command-mode Caddy reload without command WHEN doctor runs THEN provider diagnostic is actionable", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig-repo-"))
    const caddyfile = join(root, "proxy", "Caddyfile")
    const configPath = join(repo, "rig.json")

    try {
      await writeFile(
        join(root, "config.json"),
        `${JSON.stringify({
          providers: {
            defaultProfile: "default",
            caddy: {
              caddyfile,
              reload: {
                mode: "command",
              },
            },
          },
        }, null, 2)}\n`,
        "utf8",
      )
      await writeFile(
        configPath,
        `${JSON.stringify({
          name: "pantry",
          domain: "pantry.b-relay.com",
          components: {
            web: {
              mode: "managed",
              command: "bun run start -- --host 127.0.0.1 --port ${web.port}",
              port: 3070,
              health: "http://127.0.0.1:${web.port}/health",
            },
          },
          live: {
            providerProfile: "default",
            proxy: {
              upstream: "web",
            },
          },
        }, null, 2)}\n`,
        "utf8",
      )

      const { stdout, stderr, exitCode } = await runRigCommand(
        ["doctor", "--project", "pantry", "--state-root", root, "--config", configPath],
        { RIG_ROOT: root },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("[INFO] rig doctor report")
      expect(stdout).toContain('"reason":"caddy-reload-command-missing"')
      expect(stdout).toContain('"providerId":"caddy"')
      expect(stdout).toContain('"project":"pantry"')
      expect(stdout).toContain('"deployment":"live"')
      expect(stdout).toContain('"component":"web"')
      expect(stdout).toContain("Set providers.caddy.reload.command")
      await expect(readFile(caddyfile, "utf8")).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("GIVEN config set apply WHEN run from repo THEN rig.json is safely updated", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig-repo-"))
    const configPath = join(repo, "rig.json")

    try {
      await writeFile(
        configPath,
        `${JSON.stringify({
          name: "rig",
          components: {
            web: {
              mode: "managed",
              command: "printf 'started\\n'",
              port: 3070,
            },
          },
        }, null, 2)}\n`,
        "utf8",
      )

      const { stdout, stderr, exitCode } = await runRigCommand(
        ["config", "set", "--path", "live.deployBranch", "--json", "\"stable\"", "--apply"],
        { RIG_ROOT: root },
        { cwd: repo },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("[INFO] rig config applied")
      expect(stdout).toContain('"backupPath"')

      const updated = JSON.parse(await readFile(configPath, "utf8")) as {
        readonly live?: { readonly deployBranch?: string }
      }
      expect(updated.live?.deployBranch).toBe("stable")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("GIVEN rig lifecycle command help WHEN run directly THEN Effect CLI renders subcommand help", async () => {
    const { stdout, stderr, exitCode } = await runRigCommand(["up", "--help"], {})

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("Start a rig local or live lane.")
    expect(stdout).toContain("--project string")
    expect(stdout).toContain("--lane choice")
    expect(stdout).toContain("--help, -h")
  })
})

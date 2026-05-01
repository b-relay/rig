import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const runRig2Command = async (
  argv: readonly string[],
  env: Record<string, string>,
  options: {
    readonly cwd?: string
  } = {},
) => {
  const processHandle = Bun.spawn({
    cmd: [process.execPath, "run", join(process.cwd(), "src/index-rig2.ts"), ...argv],
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

describe("GIVEN rig2 entrypoint WHEN executed directly THEN behavior is covered", () => {
  test("GIVEN init command WHEN run directly THEN it writes v2 project files and registers the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig2-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig2-repo-"))

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

      const init = await runRig2Command(
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
        { RIG_V2_ROOT: root },
      )

      expect(init.exitCode).toBe(0)
      expect(init.stderr).toBe("")
      expect(init.stdout).toContain("[INFO] rig2 project initialized")
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
      expect(packageJson.scripts?.["rig:up"]).toBe("rig2 up")
      expect(packageJson.scripts?.["rig:restart"]).toBe("rig2 restart")
      expect(packageJson.scripts?.["rig:list"]).toBe("rig2 list")

      const list = await runRig2Command(["list", "--state-root", root], { RIG_V2_ROOT: root })

      expect(list.exitCode).toBe(0)
      expect(list.stderr).toBe("")
      expect(list.stdout).toContain("[INFO] rig2 projects")
      expect(list.stdout).toContain("projects:\n  pantry")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("GIVEN status command WHEN run through src/index-rig2.ts THEN it uses the isolated v2 root", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig2-root-"))

    try {
      const { stdout, stderr, exitCode } = await runRig2Command(
        ["status", "--project", "pantry"],
        { RIG_V2_ROOT: root },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("[INFO] rig2 foundation ready")
      expect(stdout).toContain("[INFO] rigd status")
      expect(stdout).toContain(`state root: ${root}`)
      expect(stdout).toContain("namespace: rig.v2.pantry")
      expect(stdout).toContain("launchd label prefix: com.b-relay.rig2")
      expect(stdout).toContain("rigd: running")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN up command without project WHEN run from repo THEN it infers current project", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig2-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig2-repo-"))

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

      const { stdout, stderr, exitCode } = await runRig2Command(
        ["up", "--state-root", root],
        { RIG_V2_ROOT: root },
        { cwd: repo },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("[INFO] rig2 lifecycle accepted")
      expect(stdout).toContain('"project":"rig"')
      expect(stdout).toContain('"target":"local"')
      expect(stdout).toContain(`"stateRoot":"${root}"`)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("GIVEN a fake project initialized by rig2 WHEN web component is added THEN local up and live deploy accept the config", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig2-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig2-fake-project-"))
    const configPath = join(repo, "rig.json")

    try {
      const init = await runRig2Command(
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
        { RIG_V2_ROOT: root },
      )

      expect(init.exitCode).toBe(0)
      expect(init.stderr).toBe("")

      const addWeb = await runRig2Command(
        [
          "config",
          "set",
          "--path",
          "components.web",
          "--json",
          JSON.stringify({
            mode: "managed",
            command: "printf 'fake web started\\n'",
            port: 3180,
          }),
          "--apply",
        ],
        { RIG_V2_ROOT: root },
        { cwd: repo },
      )

      expect(addWeb.exitCode).toBe(0)
      expect(addWeb.stderr).toBe("")
      expect(addWeb.stdout).toContain("[INFO] rig2 config applied")

      const up = await runRig2Command(
        ["up", "--state-root", root],
        { RIG_V2_ROOT: root },
        { cwd: repo },
      )

      expect(up.exitCode).toBe(0)
      expect(up.stderr).toBe("")
      expect(up.stdout).toContain("[INFO] rig2 lifecycle accepted")
      expect(up.stdout).toContain('"project":"fake-fullstack"')
      expect(up.stdout).toContain('"target":"local"')

      const deploy = await runRig2Command(
        ["deploy", "--state-root", root, "--ref", "main"],
        { RIG_V2_ROOT: root },
        { cwd: repo },
      )

      expect(deploy.exitCode).toBe(0)
      expect(deploy.stderr).toBe("")
      expect(deploy.stdout).toContain("[INFO] rig2 deploy accepted")
      expect(deploy.stdout).toContain('"project":"fake-fullstack"')
      expect(deploy.stdout).toContain('"target":"live"')

      const rigConfig = JSON.parse(await readFile(configPath, "utf8")) as {
        readonly components?: Record<string, unknown>
        readonly local?: { readonly proxy?: { readonly upstream?: string } }
      }
      expect(rigConfig.components).toMatchObject({
        sqlite: { uses: "sqlite" },
        web: {
          mode: "managed",
          command: "printf 'fake web started\\n'",
          port: 3180,
        },
      })
      expect(rigConfig.local?.proxy?.upstream).toBe("web")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("GIVEN rigd command WHEN run directly THEN it starts the local MVP API", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig2-root-"))

    try {
      const { stdout, stderr, exitCode } = await runRig2Command(
        ["rigd", "--state-root", root],
        { RIG_V2_ROOT: root },
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
    const root = await mkdtemp(join(tmpdir(), "rig2-root-"))

    try {
      const { stdout, stderr, exitCode } = await runRig2Command(
        ["deploy", "--project", "pantry", "--state-root", root, "--ref", "feature/preview", "--target", "generated"],
        { RIG_V2_ROOT: root },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("[INFO] rig2 deploy intent")
      expect(stdout).toContain('"ref":"feature/preview"')
      expect(stdout).toContain('"target":"generated"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN bump command WHEN run directly THEN it emits optional version metadata", async () => {
    const { stdout, stderr, exitCode } = await runRig2Command(
      ["bump", "--project", "pantry", "--current", "1.2.3", "--bump", "patch"],
      {},
    )

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("[INFO] rig2 bump metadata")
    expect(stdout).toContain('"nextVersion":"1.2.4"')
    expect(stdout).toContain('"rollbackAnchor":"v1.2.3"')
  })

  test("GIVEN doctor command WHEN run directly THEN it emits reliability categories", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig2-root-"))

    try {
      const { stdout, stderr, exitCode } = await runRig2Command(
        ["doctor", "--project", "pantry", "--state-root", root],
        { RIG_V2_ROOT: root },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("[INFO] rig2 doctor report")
      expect(stdout).toContain('"category":"path"')
      expect(stdout).toContain('"category":"providers"')
      expect(stdout).toContain('"name":"localhost-http"')
      expect(stdout).toContain('"family":"control-plane-transport"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN config set apply WHEN run from repo THEN rig.json is safely updated", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig2-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig2-repo-"))
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

      const { stdout, stderr, exitCode } = await runRig2Command(
        ["config", "set", "--path", "live.deployBranch", "--json", "\"stable\"", "--apply"],
        { RIG_V2_ROOT: root },
        { cwd: repo },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("[INFO] rig2 config applied")
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

  test("GIVEN v2 lifecycle command help WHEN run directly THEN Effect CLI renders subcommand help", async () => {
    const { stdout, stderr, exitCode } = await runRig2Command(["up", "--help"], {})

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("Start a v2 local or live lane.")
    expect(stdout).toContain("--project string")
    expect(stdout).toContain("--lane choice")
    expect(stdout).toContain("--help, -h")
  })
})

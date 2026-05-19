import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const runRigCommand = async (
  argv: readonly string[],
  env: Record<string, string>,
  options: {
    readonly cwd?: string
    readonly entrypoint?: "rig" | "rigd"
  } = {},
) => {
  const entrypoint = options.entrypoint === "rigd" ? "src/rigd.ts" : "src/index.ts"
  const processHandle = Bun.spawn({
    cmd: [process.execPath, "run", join(process.cwd(), entrypoint), ...argv],
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

const runRigdCommand = (
  argv: readonly string[],
  env: Record<string, string>,
  options: { readonly cwd?: string } = {},
) => runRigCommand(argv, env, { ...options, entrypoint: "rigd" })

const installRigd = async (root: string) => {
  const install = await runRigdCommand(["install"], { RIG_ROOT: root })
  expect(install.exitCode).toBe(0)
  expect(install.stderr).toBe("")
  return install
}

const runCommand = async (
  argv: readonly string[],
  options: {
    readonly cwd?: string
  } = {},
) => {
  const processHandle = Bun.spawn({
    cmd: [...argv],
    cwd: options.cwd ?? process.cwd(),
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

const initGitRepo = async (
  repo: string,
  branches: readonly string[] = [],
) => {
  const init = await runCommand(["git", "init", "-b", "main"], { cwd: repo })
  expect(init.exitCode).toBe(0)
  await writeFile(join(repo, "README.md"), "# test repo\n", "utf8")
  const add = await runCommand(["git", "add", "README.md"], { cwd: repo })
  expect(add.exitCode).toBe(0)
  const commit = await runCommand([
    "git",
    "-c",
    "user.name=Rig Test",
    "-c",
    "user.email=rig-test@example.test",
    "commit",
    "-m",
    "initial",
  ], { cwd: repo })
  expect(commit.exitCode).toBe(0)
  for (const branch of branches) {
    const created = await runCommand(["git", "branch", branch], { cwd: repo })
    expect(created.exitCode).toBe(0)
  }
}

describe("GIVEN rig entrypoint WHEN executed directly THEN behavior is covered", () => {
  test("GIVEN rigd daemon admin WHEN run directly THEN it installs and reports daemon state", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))

    try {
      const help = await runRigdCommand(["--help"], { RIG_ROOT: root })

      expect(help.exitCode).toBe(0)
      expect(help.stderr).toBe("")
      expect(help.stdout).toContain("rigd")
      expect(help.stdout).toContain("install")
      expect(help.stdout).toContain("status")
      expect(help.stdout).toContain("uninstall")
      expect(help.stdout).not.toContain("projects:")
      expect(help.stdout).not.toContain("deployments:")

      const install = await runRigdCommand(["install"], { RIG_ROOT: root })

      expect(install.exitCode).toBe(0)
      expect(install.stderr).toBe("")
      expect(install.stdout).toContain("[INFO] rigd installed")
      expect(install.stdout).toContain(`"stateRoot":"${root}"`)
      expect(install.stdout).toContain('"tokenCreated":true')

      const status = await runRigdCommand(["status"], { RIG_ROOT: root })

      expect(status.exitCode).toBe(0)
      expect(status.stderr).toBe("")
      expect(status.stdout).toContain("[INFO] rigd daemon status")
      expect(status.stdout).toContain('"installed":true')
      expect(status.stdout).toContain('"running":true')
      expect(status.stdout).toContain('"reachable":true')

      const token = await readFile(join(root, "auth", "control-plane.token"), "utf8")
      expect(token.trim().length).toBeGreaterThan(20)

      const uninstall = await runRigdCommand(["uninstall"], { RIG_ROOT: root })

      expect(uninstall.exitCode).toBe(0)
      expect(uninstall.stderr).toBe("")
      expect(uninstall.stdout).toContain("[INFO] rigd uninstalled")
      expect(uninstall.stdout).toContain('"removed":true')
      await expect(readFile(join(root, "auth", "control-plane.token"), "utf8")).rejects.toThrow()

      const afterUninstall = await runRigdCommand(["status"], { RIG_ROOT: root })

      expect(afterUninstall.exitCode).toBe(0)
      expect(afterUninstall.stderr).toBe("")
      expect(afterUninstall.stdout).toContain('"installed":false')
      expect(afterUninstall.stdout).toContain('"running":false')
      expect(afterUninstall.stdout).toContain('"reachable":false')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN running Rig target WHEN rigd uninstall runs THEN it refuses to remove daemon artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig-repo-"))

    try {
      await installRigd(root)
      await writeFile(
        join(repo, "rig.json"),
        `${JSON.stringify({
          name: "pantry",
          components: {
            web: {
              mode: "managed",
              command: "printf 'started\\n'",
              port: 3070,
            },
          },
          local: {
            providerProfile: "stub",
          },
        }, null, 2)}\n`,
        "utf8",
      )

      const up = await runRigCommand(
        ["up", "local"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: repo },
      )

      expect(up.exitCode).toBe(0)
      expect(up.stderr).toBe("")

      const uninstall = await runRigdCommand(["uninstall"], { RIG_ROOT: root })

      expect(uninstall.exitCode).toBe(1)
      expect(uninstall.stdout).toBe("")
      expect(uninstall.stderr).toContain("[ERROR] Cannot uninstall rigd while Rig Targets are running.")
      expect(uninstall.stderr).toContain("Run rig down")
      expect(uninstall.stderr).toContain('"project":"pantry"')

      const status = await runRigdCommand(["status"], { RIG_ROOT: root })

      expect(status.exitCode).toBe(0)
      expect(status.stdout).toContain('"installed":true')
      expect(status.stdout).toContain('"reachable":true')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  }, 15000)

  test("GIVEN normal rig command WHEN rigd is missing THEN it fails with daemon guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))

    try {
      const { stdout, stderr, exitCode } = await runRigCommand(
        ["status", "--project", "pantry"],
        { RIG_ROOT: root },
      )

      expect(exitCode).toBe(1)
      expect(stdout).toBe("")
      expect(stderr).toContain("[ERROR] rigd is not installed or reachable.")
      expect(stderr).toContain("Run 'rigd install'")
      expect(stderr).toContain("rigd status")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN doctor command WHEN rigd is missing THEN it reports daemon reachability instead of failing preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))

    try {
      const { stdout, stderr, exitCode } = await runRigCommand(
        ["doctor"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: root },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("[INFO] rig doctor report")
      expect(stdout).toContain('"project":"host"')
      expect(stdout).toContain('"name":"rigd-daemon"')
      expect(stdout).toContain('"reachable":false')
      expect(stdout).toContain('"reason":"rigd-unreachable"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN main help WHEN run directly THEN it identifies the final rig CLI", async () => {
    const { stdout, stderr, exitCode } = await runRigCommand(["--help"], {})

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("rig")
    expect(stdout).not.toContain("bump")
    expect(stdout).not.toContain("provider-profile")
    expect(stdout).not.toContain("package-scripts")
    expect(stdout).not.toContain("state-root")
    expect(stdout).not.toContain("--config")
    expect(stdout).not.toContain("--json")
    expect(stdout).not.toContain("--ref")
    expect(stdout).not.toContain("--target")
    expect(stdout).not.toContain("--lane")
    expect(stdout).not.toContain("lane")
    expect(stdout).not.toContain("ref")
  })

  test("GIVEN normal command help WHEN run directly THEN obsolete release surfaces are hidden", async () => {
    for (const argv of [
      ["init", "--help"],
      ["up", "--help"],
      ["status", "--help"],
      ["list", "--help"],
      ["deploy", "--help"],
      ["config", "--help"],
    ]) {
      const { stdout, stderr, exitCode } = await runRigCommand(argv, {})

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).not.toContain("provider-profile")
      expect(stdout).not.toContain("package-scripts")
      expect(stdout).not.toContain("state-root")
      expect(stdout).not.toContain("--config")
      expect(stdout).not.toContain("--json")
      expect(stdout).not.toContain("--ref")
      expect(stdout).not.toContain("--target")
      expect(stdout).not.toContain("--lane")
    }

    const bumpHelp = await runRigCommand(["bump", "--help"], {})
    expect(bumpHelp.exitCode).toBe(0)
    expect(bumpHelp.stdout).not.toContain("  bump")

    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    try {
      await installRigd(root)
      const bump = await runRigCommand(["bump"], { RIG_ROOT: root })
      expect(bump.exitCode).toBe(1)
      expect(bump.stdout).not.toContain("  bump")
      expect(bump.stderr).toContain("bump")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 10000)

  test("GIVEN init command WHEN run directly THEN it writes rig project files and registers the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig-repo-"))

    try {
      await installRigd(root)
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
          "--domain",
          "pantry.b-relay.com",
          "--proxy",
          "web",
          "--uses",
          "sqlite,postgres,convex",
        ],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
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
      expect(packageJson.scripts?.["rig:up"]).toBeUndefined()
      expect(packageJson.scripts?.["rig:restart"]).toBeUndefined()
      expect(packageJson.scripts?.["rig:list"]).toBeUndefined()

      const list = await runRigCommand(["list"], { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" })

      expect(list.exitCode).toBe(0)
      expect(list.stderr).toBe("")
      expect(list.stdout).toContain("[INFO] rig projects")
      expect(list.stdout).toContain("projects:\n  pantry")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("GIVEN init from a git subdirectory WHEN project is omitted THEN it writes root config remote and registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const parent = await mkdtemp(join(tmpdir(), "rig-init-parent-"))
    const repo = join(parent, "Pantry App")
    const nested = join(repo, "apps", "web")

    try {
      await installRigd(root)
      await mkdir(nested, { recursive: true })
      const gitInit = await runCommand(["git", "init", "-b", "main"], { cwd: repo })
      expect(gitInit.exitCode).toBe(0)

      const init = await runRigCommand(
        [
          "init",
          "--domain",
          "pantry.example.test",
          "--proxy",
          "web",
        ],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: nested },
      )

      expect(init.exitCode).toBe(0)
      expect(init.stderr).toBe("")
      expect(init.stdout).toContain("[INFO] rig project initialized")
      expect(init.stdout).toContain('"project":"pantry-app"')
      const gitRepoPath = await realpath(repo)
      expect(init.stdout).toContain(`"repoPath":"${gitRepoPath}"`)
      expect(init.stdout).toContain(`"configPath":"${join(gitRepoPath, "rig.json")}"`)
      expect(init.stdout).toContain('"productionBranch":"main"')
      expect(init.stdout).toContain('"remoteConfigured":true')
      expect(init.stdout).toContain('"registered":true')

      const rigConfig = JSON.parse(await readFile(join(repo, "rig.json"), "utf8")) as {
        readonly name?: string
        readonly live?: { readonly deployBranch?: string }
      }
      expect(rigConfig.name).toBe("pantry-app")
      expect(rigConfig.live?.deployBranch).toBe("main")

      const remote = await runCommand(["git", "remote", "get-url", "rig"], { cwd: repo })
      expect(remote.exitCode).toBe(0)
      expect(remote.stdout.trim()).toBe("rig://localhost/pantry-app")

      const list = await runRigCommand(["list"], { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" })
      expect(list.exitCode).toBe(0)
      expect(list.stdout).toContain("projects:\n  pantry-app")

      const rerun = await runRigCommand(
        ["init"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: nested },
      )

      expect(rerun.exitCode).toBe(0)
      expect(rerun.stderr).toBe("")
      expect(rerun.stdout).toContain('"project":"pantry-app"')
      expect(rerun.stdout).toContain('"remoteConfigured":false')
      expect(rerun.stdout).toContain('"registered":true')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(parent, { recursive: true, force: true })
    }
  }, 15000)

  test("GIVEN rig remote points elsewhere WHEN init runs THEN it refuses to overwrite the remote", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig-remote-conflict-"))

    try {
      await installRigd(root)
      const gitInit = await runCommand(["git", "init", "-b", "main"], { cwd: repo })
      expect(gitInit.exitCode).toBe(0)
      const addRemote = await runCommand(["git", "remote", "add", "rig", "https://example.test/not-rig.git"], {
        cwd: repo,
      })
      expect(addRemote.exitCode).toBe(0)

      const init = await runRigCommand(
        ["init", "--project", "pantry"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: repo },
      )

      expect(init.exitCode).toBe(1)
      expect(init.stdout).toBe("")
      expect(init.stderr).toContain("Cannot configure rig remote because it already points somewhere else.")
      expect(init.stderr).toContain("existingRemoteUrl")
      await expect(readFile(join(repo, "rig.json"), "utf8")).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("GIVEN config already exists without registration WHEN init reruns THEN it completes daemon registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const parent = await mkdtemp(join(tmpdir(), "rig-partial-parent-"))
    const repo = join(parent, "Partial App")
    const nested = join(repo, "packages", "web")

    try {
      await installRigd(root)
      await mkdir(nested, { recursive: true })
      const gitInit = await runCommand(["git", "init", "-b", "main"], { cwd: repo })
      expect(gitInit.exitCode).toBe(0)
      await writeFile(
        join(repo, "rig.json"),
        `${JSON.stringify({
          name: "partial-app",
          components: {},
          local: { providerProfile: "stub" },
          live: { providerProfile: "stub", deployBranch: "main" },
          deployments: { providerProfile: "stub" },
        }, null, 2)}\n`,
        "utf8",
      )

      const init = await runRigCommand(
        ["init"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: nested },
      )

      expect(init.exitCode).toBe(0)
      expect(init.stderr).toBe("")
      expect(init.stdout).toContain('"project":"partial-app"')
      expect(init.stdout).toContain('"remoteConfigured":true')
      expect(init.stdout).toContain('"registered":true')

      const list = await runRigCommand(["list"], { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" })
      expect(list.exitCode).toBe(0)
      expect(list.stdout).toContain("partial-app")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(parent, { recursive: true, force: true })
    }
  }, 15000)

  test("GIVEN project identity is already registered elsewhere WHEN init runs THEN it rejects the duplicate", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const parent = await mkdtemp(join(tmpdir(), "rig-duplicate-parent-"))
    const repoA = join(parent, "Repo A")
    const repoB = join(parent, "Repo B")

    try {
      await installRigd(root)
      await mkdir(repoA, { recursive: true })
      await mkdir(repoB, { recursive: true })
      expect((await runCommand(["git", "init", "-b", "main"], { cwd: repoA })).exitCode).toBe(0)
      expect((await runCommand(["git", "init", "-b", "main"], { cwd: repoB })).exitCode).toBe(0)

      const first = await runRigCommand(
        ["init", "--project", "pantry"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: repoA },
      )
      expect(first.exitCode).toBe(0)

      const duplicate = await runRigCommand(
        ["init", "--project", "pantry"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: repoB },
      )

      expect(duplicate.exitCode).toBe(1)
      expect(duplicate.stdout).toBe("")
      expect(duplicate.stderr).toContain("Project 'pantry' is already registered for another path.")
      await expect(readFile(join(repoB, "rig.json"), "utf8")).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(parent, { recursive: true, force: true })
    }
  }, 15000)

  test("GIVEN rigd registration write fails WHEN init wrote config THEN it reports partial state clearly", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig-partial-registration-"))
    const runtimeRoot = join(root, "runtime")

    try {
      await installRigd(root)
      await mkdir(runtimeRoot, { recursive: true })
      await chmod(runtimeRoot, 0o555)

      const init = await runRigCommand(
        ["init", "--project", "pantry", "--path", repo],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
      )

      expect(init.exitCode).toBe(1)
      expect(init.stdout).toBe("")
      expect(init.stderr).toContain("rig init wrote project config but could not register with rigd.")
      expect(init.stderr).toContain("rerun 'rig init'")

      const rigConfig = JSON.parse(await readFile(join(repo, "rig.json"), "utf8")) as {
        readonly name?: string
      }
      expect(rigConfig.name).toBe("pantry")
    } finally {
      await chmod(runtimeRoot, 0o755).catch(() => {})
      await rm(root, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  }, 15000)

  test("GIVEN init command with explicit app components WHEN run directly THEN managed and installed components are scaffolded", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig-repo-"))

    try {
      await installRigd(root)
      const init = await runRigCommand(
        [
          "init",
          "--project",
          "pantry",
          "--path",
          repo,
          "--domain",
          "pantry.b-relay.com",
          "--proxy",
          "web",
          "--uses",
          "sqlite",
          "--managed",
          "web",
          "--managed-command",
          "bun run start -- --host 127.0.0.1 --port ${web.port}",
          "--managed-port",
          "3070",
          "--managed-health",
          "http://127.0.0.1:${web.port}/health",
          "--installed",
          "cli",
          "--installed-entrypoint",
          "dist/pantry",
          "--installed-build",
          "bun run build",
          "--installed-name",
          "pantry",
        ],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
      )

      expect(init.exitCode).toBe(0)
      expect(init.stderr).toBe("")

      const rigConfig = JSON.parse(await readFile(join(repo, "rig.json"), "utf8")) as {
        readonly components?: Record<string, unknown>
        readonly live?: { readonly proxy?: { readonly upstream?: string } }
      }
      expect(rigConfig.live?.proxy?.upstream).toBe("web")
      expect(rigConfig.components).toMatchObject({
        sqlite: { uses: "sqlite" },
        web: {
          mode: "managed",
          command: "bun run start -- --host 127.0.0.1 --port ${web.port}",
          port: 3070,
          health: "http://127.0.0.1:${web.port}/health",
        },
        cli: {
          mode: "installed",
          entrypoint: "dist/pantry",
          build: "bun run build",
          installName: "pantry",
        },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("GIVEN status command WHEN run through src/index.ts THEN it uses the isolated rig root", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig-status-repo-"))

    try {
      await installRigd(root)
      const init = await runRigCommand(
        ["init", "--project", "pantry", "--path", repo],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
      )
      expect(init.exitCode).toBe(0)

      const { stdout, stderr, exitCode } = await runRigCommand(
        ["status", "--project", "pantry"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("[INFO] rig foundation ready")
      expect(stdout).toContain("[INFO] rig project status")
      expect(stdout).toContain(`state root: ${root}`)
      expect(stdout).toContain("namespace: rig.pantry")
      expect(stdout).toContain("launchd label prefix: com.b-relay.rig")
      expect(stdout).toContain("rigd: running")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("GIVEN up command without project WHEN run from repo THEN it infers current project", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig-repo-"))

    try {
      await installRigd(root)
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
          local: {
            providerProfile: "stub",
          },
          deployments: {
            providerProfile: "stub",
          },
        }, null, 2)}\n`,
        "utf8",
      )

      const { stdout, stderr, exitCode } = await runRigCommand(
        ["up", "local"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
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
      await installRigd(root)
      await initGitRepo(repo, ["feature/test"])
      const init = await runRigCommand(
        [
          "init",
          "--project",
          "fake-fullstack",
          "--path",
          repo,
          "--domain",
          "fake-fullstack.example.test",
          "--proxy",
          "web",
          "--managed",
          "web",
          "--managed-command",
          "printf 'fake web started on ${web.port}\\n'",
          "--uses",
          "sqlite",
        ],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
      )

      expect(init.exitCode).toBe(0)
      expect(init.stderr).toBe("")

      const up = await runRigCommand(
        ["up", "local"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: repo },
      )

      expect(up.exitCode).toBe(0)
      expect(up.stderr).toBe("")
      expect(up.stdout).toContain("[INFO] rig lifecycle accepted")
      expect(up.stdout).toContain('"project":"fake-fullstack"')
      expect(up.stdout).toContain('"target":"local"')

      const deploy = await runRigCommand(
        ["deploy", "live"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: repo },
      )

      expect(deploy.exitCode).toBe(0)
      expect(deploy.stderr).toBe("")
      expect(deploy.stdout).toContain("[INFO] rig deploy accepted")
      expect(deploy.stdout).toContain('"project":"fake-fullstack"')
      expect(deploy.stdout).toContain('"target":"live"')

      const generatedDeploy = await runRigCommand(
        ["deploy", "preview", "feature/test"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: repo },
      )

      expect(generatedDeploy.exitCode).toBe(0)
      expect(generatedDeploy.stderr).toBe("")
      expect(generatedDeploy.stdout).toContain("[INFO] rig deploy accepted")
      expect(generatedDeploy.stdout).toContain('"project":"fake-fullstack"')
      expect(generatedDeploy.stdout).toContain('"target":"generated:feature-test"')

      const list = await runRigCommand(
        ["list"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: repo },
      )

      expect(list.exitCode).toBe(0)
      expect(list.stderr).toBe("")
      expect(list.stdout).toContain("fake-fullstack targets=3")

      const logs = await runRigCommand(
        ["logs", "local", "--lines", "100"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: repo },
      )

      expect(logs.exitCode).toBe(0)
      expect(logs.stderr).toBe("")
      expect(logs.stdout).toContain('"deployment":"local"')
      expect(logs.stdout).toContain('"component":"sqlite"')
      expect(logs.stdout).toContain(`/data/fake-fullstack/local/sqlite/sqlite.sqlite`)

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
  }, 15000)

  test("GIVEN a Pantry-like fake app WHEN web sqlite and CLI components are configured THEN rig deploys the app shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig-pantry-like-"))
    const configPath = join(repo, "rig.json")

    try {
      await installRigd(root)
      await initGitRepo(repo, ["feature/pantry-like-preview"])
      const init = await runRigCommand(
        [
          "init",
          "--project",
          "pantry-like",
          "--path",
          repo,
          "--domain",
          "pantry-like.example.test",
          "--proxy",
          "web",
          "--managed",
          "web",
          "--managed-command",
          "printf 'pantry-like web on ${web.port} using ${sqlite.path}\\n'",
          "--uses",
          "sqlite",
          "--installed",
          "cli",
          "--installed-entrypoint",
          "dist/pantry",
          "--installed-build",
          "mkdir -p dist && printf '#!/bin/sh\\necho pantry-like:$1\\n' > dist/pantry",
          "--installed-name",
          "pantry",
        ],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
      )

      expect(init.exitCode).toBe(0)
      expect(init.stderr).toBe("")

      const up = await runRigCommand(
        ["up", "local"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: repo },
      )

      expect(up.exitCode).toBe(0)
      expect(up.stderr).toBe("")

      const liveDeploy = await runRigCommand(
        ["deploy", "live"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: repo },
      )

      expect(liveDeploy.exitCode).toBe(0)
      expect(liveDeploy.stderr).toBe("")
      expect(liveDeploy.stdout).toContain("[INFO] rig deploy accepted")
      expect(liveDeploy.stdout).toContain('"project":"pantry-like"')
      expect(liveDeploy.stdout).toContain('"target":"live"')

      const generatedDeploy = await runRigCommand(
        ["deploy", "preview", "feature/pantry-like-preview"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: repo },
      )

      expect(generatedDeploy.exitCode).toBe(0)
      expect(generatedDeploy.stderr).toBe("")
      expect(generatedDeploy.stdout).toContain('"target":"generated:feature-pantry-like-preview"')

      const list = await runRigCommand(
        ["list"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: repo },
      )

      expect(list.exitCode).toBe(0)
      expect(list.stderr).toBe("")
      expect(list.stdout).toContain("pantry-like targets=3")

      const logs = await runRigCommand(
        ["logs", "local", "--lines", "200"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: repo },
      )

      expect(logs.exitCode).toBe(0)
      expect(logs.stderr).toBe("")
      expect(logs.stdout).toContain('"component":"sqlite"')
      expect(logs.stdout).toContain('"component":"web"')
      expect(logs.stdout).toContain("/data/pantry-like/local/sqlite/sqlite.sqlite")

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
  }, 15000)

  test("GIVEN rigd command WHEN run directly THEN normal rig rejects the daemon surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))

    try {
      await installRigd(root)
      const { stdout, stderr, exitCode } = await runRigCommand(
        ["rigd"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
      )

      expect(exitCode).toBe(1)
      expect(stdout).not.toContain("[INFO] rigd local API ready")
      expect(stdout).not.toContain("  rigd")
      expect(stderr).toContain("rigd")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN deploy command without config WHEN run directly THEN it rejects runtime changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))

    try {
      await installRigd(root)
      const { stdout, stderr, exitCode } = await runRigCommand(
        ["deploy", "preview", "feature/preview", "--project", "pantry"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
      )

      expect(exitCode).toBe(1)
      expect(stdout).toBe("")
      expect(stderr).toContain("[ERROR] rig deploy requires a rig.json for runtime changes.")
      expect(stderr).toContain("Run the command from a managed repo so Rig can discover project config.")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN bump command WHEN run directly THEN normal rig rejects version metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))

    try {
      await installRigd(root)
      const { stdout, stderr, exitCode } = await runRigCommand(
        ["bump", "--project", "pantry", "--current", "1.2.3", "--bump", "patch"],
        { RIG_ROOT: root },
      )

      expect(exitCode).toBe(1)
      expect(stdout).not.toContain("[INFO] rig bump metadata")
      expect(stdout).not.toContain("  bump")
      expect(stderr).toContain("bump")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN doctor command WHEN run directly THEN it emits reliability categories", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))

    try {
      await installRigd(root)
      const { stdout, stderr, exitCode } = await runRigCommand(
        ["doctor", "--project", "pantry"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
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
      await installRigd(root)
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
        ["doctor", "--project", "pantry"],
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: repo },
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

  test("GIVEN config set apply WHEN run from repo THEN normal rig rejects generic config writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-root-"))
    const repo = await mkdtemp(join(tmpdir(), "rig-repo-"))
    const configPath = join(repo, "rig.json")

    try {
      await installRigd(root)
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
        { RIG_ROOT: root, RIG_PROVIDER_PROFILE: "stub" },
        { cwd: repo },
      )

      expect(exitCode).toBe(1)
      expect(stdout).not.toContain("[INFO] rig config applied")
      expect(stderr).toContain("set")

      const updated = JSON.parse(await readFile(configPath, "utf8")) as {
        readonly live?: { readonly deployBranch?: string }
      }
      expect(updated.live?.deployBranch).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("GIVEN rig lifecycle command help WHEN run directly THEN Effect CLI renders subcommand help", async () => {
    const { stdout, stderr, exitCode } = await runRigCommand(["up", "--help"], {})

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("Start an existing Rig Target.")
    expect(stdout).toContain("--project string")
    expect(stdout).not.toContain("--lane")
    expect(stdout).toContain("--help, -h")
  })
})

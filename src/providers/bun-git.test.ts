import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect-v3"

import { BunGit } from "./bun-git.js"
import { MainBranchDetectionError } from "../schema/errors.js"

type CommandResult = {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const runGit = async (
  cwd: string,
  args: readonly string[],
  options?: { readonly allowFailure?: boolean },
): Promise<CommandResult> => {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (exitCode !== 0 && options?.allowFailure !== true) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr || "<no stderr>"}`)
  }

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  }
}

const createRepo = async (initialBranch: string): Promise<string> => {
  const repoPath = await mkdtemp(join(tmpdir(), `rig-bun-git-${initialBranch}-`))

  await runGit(repoPath, ["init", "--initial-branch", initialBranch])
  await runGit(repoPath, ["config", "user.email", "rig-test@example.com"])
  await runGit(repoPath, ["config", "user.name", "Rig Test"])

  await writeFile(join(repoPath, "tracked.txt"), "tracked\n", "utf8")
  await runGit(repoPath, ["add", "tracked.txt"])
  await runGit(repoPath, ["commit", "-m", "initial commit"])

  return repoPath
}

describe("GIVEN suite context WHEN BunGit THEN behavior is covered", () => {
  test("GIVEN test setup WHEN detectMainBranch resolves main and master via convention fallback THEN expected behavior is observed", async () => {
    const git = new BunGit()
    const mainRepo = await createRepo("main")
    const masterRepo = await createRepo("master")

    const mainBranch = await Effect.runPromise(git.detectMainBranch(mainRepo))
    const masterBranch = await Effect.runPromise(git.detectMainBranch(masterRepo))

    expect(mainBranch).toBe("main")
    expect(masterBranch).toBe("master")

    await rm(mainRepo, { recursive: true, force: true })
    await rm(masterRepo, { recursive: true, force: true })
  })

  test("GIVEN test setup WHEN detectMainBranch fails with MainBranchDetectionError when no main/master branch exists THEN expected behavior is observed", async () => {
    const git = new BunGit()
    const repoPath = await createRepo("trunk")

    const result = await Effect.runPromise(git.detectMainBranch(repoPath).pipe(Effect.either))
    expect(result._tag).toBe("Left")

    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(MainBranchDetectionError)
      if (result.left._tag === "MainBranchDetectionError") {
        expect(result.left.strategiesTried).toEqual(["remote-head", "convention"])
      }
    }

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN test setup WHEN supports state queries, tags, and worktree lifecycle THEN expected behavior is observed", async () => {
    const git = new BunGit()
    const repoPath = await createRepo("main")

    const branch = await Effect.runPromise(git.currentBranch(repoPath))
    const headHash = await Effect.runPromise(git.commitHash(repoPath))
    const expectedHash = await runGit(repoPath, ["rev-parse", "HEAD"])

    expect(branch).toBe("main")
    expect(headHash).toBe(expectedHash.stdout)
    expect(await Effect.runPromise(git.isDirty(repoPath))).toBe(false)

    await writeFile(join(repoPath, "tracked.txt"), "tracked v2\n", "utf8")
    await Effect.runPromise(git.commit(repoPath, "chore: update tracked", ["tracked.txt"]))
    const committedHash = await Effect.runPromise(git.commitHash(repoPath))
    expect(committedHash).not.toBe(headHash)
    expect(await Effect.runPromise(git.isDirty(repoPath))).toBe(false)

    await writeFile(join(repoPath, "scratch.txt"), "dirty\n", "utf8")
    expect(await Effect.runPromise(git.isDirty(repoPath))).toBe(true)

    const changed = await Effect.runPromise(git.changedFiles(repoPath))
    expect(changed).toContain("scratch.txt")

    await Effect.runPromise(git.createTag(repoPath, "v0.1.0"))
    expect(await Effect.runPromise(git.tagExists(repoPath, "v0.1.0"))).toBe(true)
    expect(await Effect.runPromise(git.commitHasTag(repoPath, committedHash))).toBe("v0.1.0")

    await Effect.runPromise(git.deleteTag(repoPath, "v0.1.0"))
    expect(await Effect.runPromise(git.tagExists(repoPath, "v0.1.0"))).toBe(false)
    expect(await Effect.runPromise(git.commitHasTag(repoPath, committedHash))).toBe(null)

    const worktreePath = join(tmpdir(), `rig-worktree-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await Effect.runPromise(git.createWorktree(repoPath, worktreePath, "HEAD"))
    await access(join(worktreePath, ".git"))

    await Effect.runPromise(git.removeWorktree(repoPath, worktreePath))
    await expect(access(worktreePath)).rejects.toBeDefined()

    await rm(repoPath, { recursive: true, force: true })
  })
})

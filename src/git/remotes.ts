import { RigError } from "../domain/errors";
import type { CommandRunner } from "../providers/contracts";

interface RemoteInput {
  repoPath: string;
  project: string;
}
export function rigRemoteUrl(project: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(project))
    throw new RigError(
      "PROJECT_NAME",
      "The Project name cannot form a Rig remote.",
      "Use letters, digits, dashes, and underscores.",
    );
  return `rig://localhost/${project}`;
}
/** Verifies fetch and push destinations together, including explicit push URL overrides. */
export async function inspectRigRemote(
  input: RemoteInput,
  run: CommandRunner,
): Promise<{ exists: boolean; explicitPushUrl: boolean }> {
  const expected = rigRemoteUrl(input.project);
  const remotes = await run({
    command: ["git", "remote"],
    cwd: input.repoPath,
  });
  if (remotes.exitCode !== 0)
    throw new RigError(
      "GIT_REMOTE",
      "Unable to inspect Git remotes.",
      "Check the repository configuration.",
    );
  if (!remotes.stdout.split(/\r?\n/).includes("rig"))
    return { exists: false, explicitPushUrl: false };
  for (const args of [
    ["remote", "get-url", "--all", "rig"],
    ["remote", "get-url", "--push", "--all", "rig"],
  ]) {
    const result = await run({
      command: ["git", ...args],
      cwd: input.repoPath,
    });
    if (result.exitCode !== 0 || result.stdout.trim() !== expected)
      throw conflict();
  }
  const push = await run({
    command: ["git", "config", "--get-all", "remote.rig.pushurl"],
    cwd: input.repoPath,
  });
  if (push.exitCode !== 0 && push.exitCode !== 1)
    throw new RigError(
      "GIT_REMOTE",
      "Unable to inspect the Rig push URL.",
      "Check Git configuration permissions.",
    );
  return { exists: true, explicitPushUrl: push.exitCode === 0 };
}
export async function ensureRigRemote(
  input: RemoteInput,
  run: CommandRunner,
): Promise<{ remoteConfigured: boolean; remoteUrl: string }> {
  const remoteUrl = rigRemoteUrl(input.project);
  if ((await inspectRigRemote(input, run)).exists)
    return { remoteConfigured: false, remoteUrl };
  const added = await run({
    command: ["git", "remote", "add", "rig", remoteUrl],
    cwd: input.repoPath,
  });
  if (added.exitCode !== 0)
    throw new RigError(
      "GIT_REMOTE",
      "Unable to add the Rig remote.",
      "Check that the Git configuration is writable.",
    );
  return { remoteConfigured: true, remoteUrl };
}

/** Returns an explicit compensation action for a larger Project rename transaction. */
export async function renameRigRemote(
  input: { repoPath: string; oldName: string; newName: string },
  run: CommandRunner,
): Promise<{ changed: boolean; restore(): Promise<void> }> {
  const before = await inspectRigRemote(
    { repoPath: input.repoPath, project: input.oldName },
    run,
  );
  if (!before.exists)
    throw new RigError(
      "GIT_REMOTE_MISSING",
      "The Project has no Rig remote.",
      "Rerun rig init before renaming it.",
    );
  const oldUrl = rigRemoteUrl(input.oldName),
    newUrl = rigRemoteUrl(input.newName);
  if (oldUrl === newUrl) return { changed: false, async restore() {} };
  let fetchChanged = false,
    pushChanged = false;
  try {
    await replaceUrl(input.repoPath, oldUrl, newUrl, false, run);
    fetchChanged = true;
    if (before.explicitPushUrl) {
      await replaceUrl(input.repoPath, oldUrl, newUrl, true, run);
      pushChanged = true;
    }
    await inspectRigRemote(
      { repoPath: input.repoPath, project: input.newName },
      run,
    );
  } catch (error) {
    try {
      if (pushChanged)
        await replaceUrl(input.repoPath, newUrl, oldUrl, true, run);
      if (fetchChanged)
        await replaceUrl(input.repoPath, newUrl, oldUrl, false, run);
    } catch {
      throw new RigError(
        "GIT_REMOTE_ROLLBACK",
        "The Rig remote update failed and could not be fully restored.",
        "Inspect git remote -v before retrying Project rename.",
      );
    }
    throw error;
  }
  return {
    changed: true,
    async restore() {
      await inspectRigRemote(
        { repoPath: input.repoPath, project: input.newName },
        run,
      );
      if (before.explicitPushUrl)
        await replaceUrl(input.repoPath, newUrl, oldUrl, true, run);
      await replaceUrl(input.repoPath, newUrl, oldUrl, false, run);
    },
  };
}
async function replaceUrl(
  repoPath: string,
  expected: string,
  next: string,
  push: boolean,
  run: CommandRunner,
): Promise<void> {
  const pattern = "^" + expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
  const result = await run({
    command: [
      "git",
      "remote",
      "set-url",
      ...(push ? ["--push"] : []),
      "rig",
      next,
      pattern,
    ],
    cwd: repoPath,
  });
  if (result.exitCode !== 0) throw conflict();
}
function conflict(): RigError {
  return new RigError(
    "GIT_REMOTE_CONFLICT",
    "The existing rig remote points to a different destination.",
    "Rename or remove that remote explicitly, then rerun rig init.",
  );
}

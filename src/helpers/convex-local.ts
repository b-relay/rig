import { join } from "node:path";
import { RigError, boundedEvidence, lastOutputLine } from "../domain/errors";
import type {
  ChildExit,
  ConvexHelperDependencies,
  RunningChild,
} from "./convex-contracts";
import {
  backendArguments,
  backendEnvironment,
  backendUrl,
  convexDevEnvironment,
  deploymentFiles,
  newDeploymentRelease,
  nextRelease,
  parseDeploymentConfig,
  releasedBefore,
  selfHostedEnvFile,
  type DeploymentConfig,
} from "./convex-deployment";

/** How long the backend may take to answer after it starts; Rig's `ready_timeout` bounds the whole start as well. */
export const BACKEND_START_MS = 120_000;
const BACKEND_POLL_MS = 250;
/** The command `convex dev` runs as: the Project's own Convex CLI, through bunx, as the version 1 recipe ran it. */
const CONVEX_DEV = ["bunx", "convex", "dev"] as const;

/** One `rigd convex` run, as its command line and entrypoint state it. */
export interface ConvexRunRequest {
  /** Loopback port of the backend's API, which clients and the recipe's `ready` use. */
  readonly cloudPort: number;
  /** Loopback port of the backend's HTTP actions. */
  readonly sitePort: number;
  /** Absolute deployment directory; the recipe keeps it in the Service's persistent data, so a deploy keeps it. */
  readonly stateDir: string;
  /** Absolute Target workspace: `convex dev` runs there, `.env.local` is written there, and a deployment that
   * `convex dev --local` left in its `.convex/local/default` is copied from there. */
  readonly workspace: string;
  /** The name a new deployment gets. An existing deployment keeps the name its admin key was made for. */
  readonly instanceName: string;
  /** A backend release to run instead of the one Convex recommends. */
  readonly pinnedRelease?: string;
  /** Extra arguments for `convex dev`. */
  readonly devArguments: readonly string[];
  /** The environment both children inherit. */
  readonly environment: Readonly<Record<string, string | undefined>>;
}

/** Runs a Convex deployment until it ends or `stop` aborts: opens (or adopts, or creates) the deployment in `stateDir`,
 * starts its backend on 127.0.0.1, points `.env.local` at it, then runs `convex dev` against it. Both children are
 * supervised together: when one ends by itself the other is stopped, and a stop is passed to both and waited out.
 * Returns 0 after a requested stop, otherwise the exit code of the child that ended first (1 when it ended cleanly or by
 * a signal, since the Service did not ask it to). Throws a RigError, having stopped any child it started, when the
 * deployment cannot be opened, the backend cannot be obtained, or it does not come up. */
export async function runConvexDeployment(
  request: ConvexRunRequest,
  deps: ConvexHelperDependencies,
  stop: AbortSignal,
): Promise<number> {
  const pinned = request.pinnedRelease;
  const recommended = pinned
    ? undefined
    : await deps.releases.recommended(stop);
  if (stop.aborted) return 0;
  const offer = {
    ...(pinned ? { pinned } : {}),
    ...(recommended ? { recommended } : {}),
  };
  const deployment = await openDeployment(request, offer, deps, stop);
  if (stop.aborted) return 0;
  const backend = await obtainBackend(
    deployment.backendVersion,
    offer,
    deps,
    stop,
  );
  if (stop.aborted) return 0;
  const url = backendUrl(request.cloudPort);
  const envFile = join(request.workspace, ".env.local");
  await deps.files.writePrivate(
    envFile,
    selfHostedEnvFile(await deps.files.read(envFile), {
      url,
      adminKey: deployment.adminKey,
    }),
  );
  const children: RunningChild[] = [];
  try {
    const server = deps.children.start({
      command: [
        backend.binary,
        ...backendArguments({ deployment, ...request }),
      ],
      cwd: request.workspace,
      env: backendEnvironment(request.environment),
    });
    children.push(server);
    const started = await backendAnswers(
      { url, name: deployment.deploymentName, server },
      deps,
      stop,
    );
    if (started === "stopped") return 0;
    if (started !== "up") return failed("The Convex backend", started, deps);
    await recordRelease(request.stateDir, deployment, backend.release, deps);
    deps.output.write(
      `Convex backend ${deployment.deploymentName} (${backend.release}) is up at ${url}\n`,
    );
    const dev = deps.children.start({
      command: [...CONVEX_DEV, ...request.devArguments],
      cwd: request.workspace,
      env: convexDevEnvironment(request.environment, {
        url,
        adminKey: deployment.adminKey,
      }),
    });
    children.push(dev);
    const first = await firstEnd(
      [
        { label: "The Convex backend", child: server },
        { label: "convex dev", child: dev },
      ],
      stop,
    );
    return first ? failed(first.label, first.exit, deps) : 0;
  } finally {
    for (const child of children) child.stop();
    await Promise.all(children.map((child) => child.exited));
  }
}

/** The deployment kept in `stateDir`; else one `convex dev --local` left in the workspace, copied there first; else a new one. */
async function openDeployment(
  request: ConvexRunRequest,
  offer: { pinned?: string; recommended?: string },
  deps: ConvexHelperDependencies,
  stop: AbortSignal,
): Promise<DeploymentConfig> {
  const own = deploymentFiles(request.stateDir).config;
  const kept = await deps.files.read(own);
  if (kept !== undefined) return parseDeploymentConfig(kept, own);
  const local = join(request.workspace, ".convex", "local", "default");
  const left = await deps.files.read(deploymentFiles(local).config);
  if (left !== undefined) {
    const deployment = parseDeploymentConfig(
      left,
      deploymentFiles(local).config,
    );
    await deps.files.copyDirectory(local, request.stateDir);
    deps.output.write(
      `Copied the Convex deployment ${deployment.deploymentName} from ${local} to ${request.stateDir}; the original is left in place.\n`,
    );
    return deployment;
  }
  return await createDeployment(request, offer, deps, stop);
}

/** A new, empty deployment with its own instance secret and admin key, saved as `convex dev --local` saves one. */
async function createDeployment(
  request: ConvexRunRequest,
  offer: { pinned?: string; recommended?: string },
  deps: ConvexHelperDependencies,
  stop: AbortSignal,
): Promise<DeploymentConfig> {
  const release = newDeploymentRelease({
    ...offer,
    cached:
      offer.pinned || offer.recommended ? [] : await deps.releases.cached(),
  });
  if (!release)
    throw new RigError(
      "CONVEX_BACKEND_UNAVAILABLE",
      "No Convex backend release could be chosen for a new deployment: version.convex.dev did not answer, and Convex's binary cache (~/.cache/convex/binaries) holds no backend.",
      "Start the Service again with a network connection, or fill the cache by running bunx convex dev --local once, or pass --backend-version with a release to download.",
    );
  const binary = await deps.releases.binary(release, stop);
  const instanceSecret = deps.newInstanceSecret();
  const deployment: DeploymentConfig = {
    deploymentName: request.instanceName,
    backendVersion: release,
    adminKey: await adminKey(
      binary,
      request.instanceName,
      instanceSecret,
      deps,
    ),
    instanceSecret,
  };
  await deps.files.ensureDirectory(request.stateDir);
  await deps.files.writePrivate(
    deploymentFiles(request.stateDir).config,
    `${JSON.stringify(deployment, null, 2)}\n`,
  );
  deps.output.write(
    `Created Convex deployment ${deployment.deploymentName} (backend ${release}) in ${request.stateDir}\n`,
  );
  return deployment;
}

/** The admin key for one instance name and secret, made by the backend's own `keygen`. Throws CONVEX_KEYGEN. */
async function adminKey(
  binary: string,
  name: string,
  secret: string,
  deps: Pick<ConvexHelperDependencies, "run">,
): Promise<string> {
  const result = await deps.run({
    command: [
      binary,
      "keygen",
      "admin-key",
      "--instance-name",
      name,
      "--instance-secret",
      secret,
    ],
    timeoutMs: 30_000,
  });
  const key = result.stdout.trim();
  if (result.exitCode === 0 && key) return key;
  throw new RigError(
    "CONVEX_KEYGEN",
    `The Convex backend could not make an admin key for ${name}${result.timedOut ? " in 30 s" : ""}.`,
    "Check the backend binary with --help; delete its directory in ~/.cache/convex/binaries to download it again.",
    {
      binary,
      ...(lastOutputLine(result.stderr)
        ? { evidence: boundedEvidence(lastOutputLine(result.stderr)!) }
        : {}),
    },
  );
}

/** The backend binary to run and its release: the next release when it can be obtained, else the deployment's own. */
async function obtainBackend(
  current: string,
  offer: { pinned?: string; recommended?: string },
  deps: Pick<ConvexHelperDependencies, "releases" | "output">,
  stop: AbortSignal,
): Promise<{ release: string; binary: string }> {
  const { release, fallback } = nextRelease(current, offer);
  if (offer.pinned && releasedBefore(offer.pinned, current))
    deps.output.error(
      `Moving the deployment from Convex backend ${current} back to ${offer.pinned}: an older backend may not read data a newer one wrote.\n`,
    );
  if (fallback === undefined)
    return { release, binary: await deps.releases.binary(release, stop) };
  try {
    return { release, binary: await deps.releases.binary(release, stop) };
  } catch (error) {
    if (!(error instanceof RigError) || stop.aborted) throw error;
    deps.output.error(
      `Staying on Convex backend ${fallback}: ${error.message}\n`,
    );
    return {
      release: fallback,
      binary: await deps.releases.binary(fallback, stop),
    };
  }
}

/** Waits for the backend to answer with this deployment's name: `up`, `stopped` when a stop came first, or how it ended.
 * Throws CONVEX_PORT_TAKEN when another deployment answers on the port, and CONVEX_BACKEND_START when nothing answers in time. */
async function backendAnswers(
  input: { url: string; name: string; server: RunningChild },
  deps: Pick<ConvexHelperDependencies, "probe" | "wait" | "now">,
  stop: AbortSignal,
): Promise<"up" | "stopped" | ChildExit> {
  let ended: ChildExit | undefined;
  void input.server.exited.then((exit) => (ended = exit));
  const deadline = deps.now() + BACKEND_START_MS;
  for (;;) {
    if (stop.aborted) return "stopped";
    const answer = await deps.probe(`${input.url}/instance_name`, stop);
    if (answer === input.name) return "up";
    if (stop.aborted) return "stopped";
    if (ended) return ended;
    if (answer !== undefined)
      throw new RigError(
        "CONVEX_PORT_TAKEN",
        `Another Convex backend (${boundedEvidence(answer) ?? "unnamed"}) answers at ${input.url}.`,
        "Stop the other backend, or give this Service other ports.",
        { url: input.url },
      );
    if (deps.now() >= deadline)
      throw new RigError(
        "CONVEX_BACKEND_START",
        `The Convex backend did not answer at ${input.url} within ${BACKEND_START_MS / 1000} s.`,
        "Inspect the Target log for the backend's own output.",
        { url: input.url },
      );
    await deps.wait(BACKEND_POLL_MS, stop);
  }
}

/** Records a release the backend has started on, so the next start does not take it for an upgrade again. */
async function recordRelease(
  stateDir: string,
  deployment: DeploymentConfig,
  release: string,
  deps: Pick<ConvexHelperDependencies, "files" | "output">,
): Promise<void> {
  if (release === deployment.backendVersion) return;
  await deps.files.writePrivate(
    deploymentFiles(stateDir).config,
    `${JSON.stringify({ ...deployment, backendVersion: release }, null, 2)}\n`,
  );
  deps.output.write(
    `Moved the Convex deployment from backend ${deployment.backendVersion} to ${release}\n`,
  );
}

/** The first of the children to end, or undefined when `stop` aborted first. */
async function firstEnd(
  children: readonly { label: string; child: RunningChild }[],
  stop: AbortSignal,
): Promise<{ label: string; exit: ChildExit } | undefined> {
  let release = () => {};
  const stopped = new Promise<undefined>((resolve) => {
    if (stop.aborted) return resolve(undefined);
    const listener = () => resolve(undefined);
    stop.addEventListener("abort", listener, { once: true });
    release = () => stop.removeEventListener("abort", listener);
  });
  try {
    return await Promise.race([
      stopped,
      ...children.map(({ label, child }) =>
        child.exited.then((exit) => ({ label, exit })),
      ),
    ]);
  } finally {
    release();
  }
}

/** Says how a child ended by itself and returns the helper's exit code for it: never 0, since nothing asked it to end. */
function failed(
  label: string,
  exit: ChildExit,
  deps: Pick<ConvexHelperDependencies, "output">,
): number {
  const how =
    "code" in exit
      ? `exited with code ${exit.code}`
      : "signal" in exit
        ? `ended by ${exit.signal}`
        : `could not start (${exit.startError})`;
  deps.output.error(`${label} ${how}; stopping the Convex Service.\n`);
  return "code" in exit && exit.code !== 0 ? exit.code : 1;
}

// Runs a local Convex backend on 127.0.0.1 and keeps `convex dev` pushing this Project's functions to it.
//
// Written by `rig recipe generate convex` (convex@2). This file is yours: commit it, and edit it if you need to. Run
// `rig recipe diff` to see whether a newer Rig carries a newer copy.
//
// Why it exists: `convex dev --local` starts its backend on 0.0.0.0, and Rig only runs Services that listen on
// loopback. So this script starts the backend binary itself with `--interface 127.0.0.1`, and runs `convex dev`
// against it the way Convex's self-hosted setup does (CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY).
//
// Settings (the recipe's `env` sets the first three):
//   CONVEX_CLOUD_PORT       loopback port of the backend's API (clients, and the recipe's `ready`)
//   CONVEX_SITE_PORT        loopback port of the backend's HTTP actions
//   CONVEX_STATE_DIR        absolute directory that keeps the deployment: the Service's persistent data
//   CONVEX_INSTANCE_NAME    name of a new deployment (default convex-self-hosted); an existing one keeps its own
//   CONVEX_BACKEND_VERSION  run this backend release instead of the one Convex recommends
//   CONVEX_BACKEND_VERSION_URL, CONVEX_BACKEND_DOWNLOAD_URL
//                           where to ask for the recommended release and download releases (a mirror)
// Arguments after the script name go to `convex dev`, for example `-- --typecheck disable`.
//
// What it does:
// - The deployment lives in CONVEX_STATE_DIR, in the layout `convex dev --local` uses (config.json, the SQLite
//   database, convex_local_storage). A deployment `convex dev --local` left in .convex/local/default is copied there
//   the first time (the original stays).
// - The backend binary comes from Convex's own cache (~/.cache/convex/binaries), which `convex dev` shares. Like
//   `convex dev`, it runs the release Convex recommends and moves an existing deployment to it; a release missing from
//   the cache is downloaded (network and `unzip` needed). Offline, it stays on what is cached.
// - .env.local is pointed at the backend, so other `bunx convex` commands in this directory reach it. Lines choosing
//   another deployment (CONVEX_DEPLOYMENT, CONVEX_DEPLOY_KEY, CONVEX_DEPLOYMENT_TOKEN) are commented out, and
//   `convex dev` runs with them set empty. Keep .env.local out of Git: it holds the admin key.
// - Both processes are supervised together. SIGTERM (a stop) is passed to both and the script exits once they have;
//   when one ends by itself, the other is stopped and the script exits with a failure.
//
// It uses only Bun's and Node's built-in modules, so it runs from any checkout of this Project.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

// ---------------------------------------------------------------------------------------------------------------------
// Errors: a message saying what went wrong, and a hint saying what to do. They are printed to stderr, which Rig records
// in the Target log.

export class HelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "HelperError";
  }
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/** One printable line of untrusted text, at most 500 characters. */
function evidence(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f\s]+/g, " ")
    .trim()
    .slice(0, 500);
}
function lastLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings

/** What one run is asked to do. */
export interface ConvexRunRequest {
  readonly cloudPort: number;
  readonly sitePort: number;
  /** Absolute; keeps the deployment. */
  readonly stateDir: string;
  /** Absolute; `convex dev` runs here, .env.local is written here, .convex/local/default is adopted from here. */
  readonly workspace: string;
  /** The name a new deployment gets. */
  readonly instanceName: string;
  /** A backend release to run instead of the recommended one. */
  readonly pinnedRelease?: string;
  /** Extra arguments for `convex dev`. */
  readonly devArguments: readonly string[];
  /** The environment both children inherit. */
  readonly environment: Readonly<Record<string, string | undefined>>;
}
const RELEASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INSTANCE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DEFAULT_INSTANCE_NAME = "convex-self-hosted";

/** The run the environment and arguments ask for. Throws HelperError CONVEX_SETTINGS naming the first bad setting. */
export function readSettings(
  environment: Readonly<Record<string, string | undefined>>,
  args: readonly string[],
  workspace: string,
): ConvexRunRequest {
  const bad = (name: string, rule: string) =>
    new HelperError(
      "CONVEX_SETTINGS",
      `${name} ${rule}.`,
      "Set it in the Service's env in rig.yaml; the convex recipe sets CONVEX_CLOUD_PORT, CONVEX_SITE_PORT and CONVEX_STATE_DIR.",
      { setting: name },
    );
  const port = (name: string) => {
    const text = environment[name];
    const value = Number(text);
    if (!text || !Number.isInteger(value) || value < 1 || value > 65535)
      throw bad(name, "must be a port number from 1 to 65535");
    return value;
  };
  const cloudPort = port("CONVEX_CLOUD_PORT");
  const sitePort = port("CONVEX_SITE_PORT");
  if (sitePort === cloudPort)
    throw bad("CONVEX_SITE_PORT", "must differ from CONVEX_CLOUD_PORT");
  const stateDir = environment.CONVEX_STATE_DIR;
  if (!stateDir || !isAbsolute(stateDir))
    throw bad(
      "CONVEX_STATE_DIR",
      "must be an absolute directory, such as ${rig.data}/backend",
    );
  const instanceName =
    environment.CONVEX_INSTANCE_NAME || DEFAULT_INSTANCE_NAME;
  if (!INSTANCE_NAME.test(instanceName))
    throw bad(
      "CONVEX_INSTANCE_NAME",
      "must be lowercase letters, digits and '-', starting with a letter or digit",
    );
  const pinned = environment.CONVEX_BACKEND_VERSION || undefined;
  if (pinned !== undefined && !RELEASE_NAME.test(pinned))
    throw bad(
      "CONVEX_BACKEND_VERSION",
      "must be a Convex backend release name such as precompiled-2026-09-21-0cf49cb",
    );
  return {
    cloudPort,
    sitePort,
    stateDir,
    workspace,
    instanceName,
    ...(pinned ? { pinnedRelease: pinned } : {}),
    devArguments: args[0] === "--" ? args.slice(1) : [...args],
    environment,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The deployment: its files, its config.json, and the environment and arguments of the two processes

/** A deployment's config.json, as `convex dev --local` writes it. Other fields (ports, cloudProjectId) are kept. An older
 * Convex CLI wrote no instance secret (the backend used a fixed legacy one), and so possibly no admin key. */
export interface DeploymentConfig {
  deploymentName: string;
  backendVersion: string;
  adminKey?: string;
  instanceSecret?: string;
  [other: string]: unknown;
}
/** A deployment with credentials of its own, which is what the backend is started with. */
export type Deployment = DeploymentConfig & {
  adminKey: string;
  instanceSecret: string;
};
/** The instance secret every local backend shared before the Convex CLI made one per deployment. */
const LEGACY_INSTANCE_SECRET =
  "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";

export function hasOwnCredentials(
  config: DeploymentConfig,
): config is Deployment {
  return (
    typeof config.adminKey === "string" &&
    typeof config.instanceSecret === "string" &&
    config.instanceSecret !== LEGACY_INSTANCE_SECRET
  );
}
/** The files of one deployment directory, laid out as `convex dev --local` lays them out. */
export function deploymentFiles(stateDir: string) {
  return {
    config: join(stateDir, "config.json"),
    storage: join(stateDir, "convex_local_storage"),
    database: join(stateDir, "convex_local_backend.sqlite3"),
  };
}
/** The deployment a config.json holds. Throws HelperError CONVEX_STATE_INVALID naming the file. */
export function parseDeploymentConfig(
  text: string,
  path: string,
): DeploymentConfig {
  let problem = "it is not valid JSON";
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      problem = "it is not a JSON object";
    else {
      const config = value as Record<string, unknown>;
      const optionalText = (key: string) =>
        config[key] === undefined ||
        (typeof config[key] === "string" && config[key] !== "");
      if (typeof config.deploymentName !== "string" || !config.deploymentName)
        problem = "deploymentName is missing";
      else if (
        typeof config.backendVersion !== "string" ||
        !RELEASE_NAME.test(config.backendVersion)
      )
        problem = "backendVersion is not a Convex backend release name";
      else if (!optionalText("adminKey") || !optionalText("instanceSecret"))
        problem = "adminKey or instanceSecret is not a string";
      else return config as DeploymentConfig;
    }
  } catch {
    /* The default problem says it. */
  }
  throw new HelperError(
    "CONVEX_STATE_INVALID",
    `The Convex deployment config ${path} cannot be used: ${problem}.`,
    "Restore the file from a backup, or move the deployment directory aside to start a new, empty deployment.",
    { path },
  );
}
export function backendUrl(cloudPort: number): string {
  return `http://127.0.0.1:${cloudPort}`;
}
/** The backend's arguments, bound to loopback. The secret is an argument because the backend reads it nowhere else;
 * `convex dev --local` passes it the same way. */
export function backendArguments(input: {
  deployment: Deployment;
  stateDir: string;
  cloudPort: number;
  sitePort: number;
}): string[] {
  const files = deploymentFiles(input.stateDir);
  return [
    "--interface",
    "127.0.0.1",
    "--port",
    String(input.cloudPort),
    "--site-proxy-port",
    String(input.sitePort),
    "--instance-name",
    input.deployment.deploymentName,
    "--instance-secret",
    input.deployment.instanceSecret,
    "--local-storage",
    files.storage,
    "--disable-beacon",
    files.database,
  ];
}
/** Release names start with their date (precompiled-YYYY-MM-DD-<commit>); true only when both have one and `release`
 * is from an earlier day. */
export function releasedBefore(release: string, than: string): boolean {
  const day = (name: string) => /\d{4}-\d{2}-\d{2}/.exec(name)?.[0];
  const [a, b] = [day(release), day(than)];
  return a !== undefined && b !== undefined && a < b;
}
/** The release a new deployment starts on: the pinned one, else the recommended one, else (offline) the newest cached. */
export function newDeploymentRelease(offer: {
  pinned?: string;
  recommended?: string;
  cached: readonly string[];
}): string | undefined {
  // The dated names sort by day.
  return offer.pinned ?? offer.recommended ?? [...offer.cached].sort().at(-1);
}
/** The release an existing deployment runs next. Like `convex dev`, it moves to the recommended release when that is not
 * older; `fallback` is its own release, for when the newer one cannot be obtained. A pin is run as asked. */
export function nextRelease(
  current: string,
  offer: { pinned?: string; recommended?: string },
): { release: string; fallback?: string } {
  if (offer.pinned) return { release: offer.pinned };
  const { recommended } = offer;
  return recommended &&
    recommended !== current &&
    !releasedBefore(recommended, current)
    ? { release: recommended, fallback: current }
    : { release: current };
}

/** Lines of .env.local that point `bunx convex` at a self-hosted backend: this script's, or a hand-written one's. */
const MANAGED_LINE =
  /^\s*(?:export\s+)?(?:CONVEX_SELF_HOSTED_URL|CONVEX_SELF_HOSTED_ADMIN_KEY)\s*=|^# Convex backend run by /;
/** Variables that choose another deployment: a Cloud deploy key or token, which the Convex CLI prefers to the
 * self-hosted pair, and CONVEX_DEPLOYMENT, which it refuses beside the pair. */
export const OTHER_DEPLOYMENT_VARIABLES = [
  "CONVEX_DEPLOY_KEY",
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_DEPLOYMENT",
] as const;
const OTHER_DEPLOYMENT = new RegExp(
  `^\\s*(?:export\\s+)?(?:${OTHER_DEPLOYMENT_VARIABLES.join("|")})\\s*=`,
);
const HEADER = "# Convex backend run by scripts/rig-convex.ts";
const SET_ASIDE = "  # set aside by rig-convex.ts";
/** .env.local with the self-hosted pair pointing at this backend. A line setting another deployment is commented out,
 * not removed; every other line is kept, in order. The pair and its comment go last. */
export function selfHostedEnvFile(
  existing: string | undefined,
  input: { url: string; adminKey: string },
): string {
  const kept = (existing ?? "")
    .split("\n")
    .filter((line) => !MANAGED_LINE.test(line))
    .map((line) =>
      OTHER_DEPLOYMENT.test(line) ? `# ${line}${SET_ASIDE}` : line,
    )
    .join("\n")
    .trim();
  const pair = [
    HEADER,
    `CONVEX_SELF_HOSTED_URL=${input.url}`,
    `CONVEX_SELF_HOSTED_ADMIN_KEY=${input.adminKey}`,
  ].join("\n");
  return `${kept ? `${kept}\n\n` : ""}${pair}\n`;
}
/** `convex dev`'s environment: the self-hosted pair, and the variables choosing another deployment set empty (the Convex
 * CLI treats empty as unset, and its dotenv loading never replaces a variable that is set). */
export function convexDevEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  input: { url: string; adminKey: string },
): Record<string, string> {
  const result = defined(environment);
  for (const key of OTHER_DEPLOYMENT_VARIABLES) result[key] = "";
  result.CONVEX_SELF_HOSTED_URL = input.url;
  result.CONVEX_SELF_HOSTED_ADMIN_KEY = input.adminKey;
  return result;
}
/** The backend's environment. TZ is left out: the backend panics at startup when TZ is set ("Convex requires UTC").
 * Its own request logs are left out unless RUST_LOG asks for them; `convex dev` tails the function logs. */
export function backendEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result = defined(environment);
  delete result.TZ;
  result.RUST_LOG ??= "warn";
  return result;
}
function defined(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment))
    if (value !== undefined) result[key] = value;
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// What the run needs from outside itself. `main` supplies the real ones; tests supply their own.

/** Convex's backend releases and the binary cache `convex dev` shares. */
export interface BackendReleases {
  /** The release Convex recommends now; undefined when it cannot be asked (offline) or gives no usable answer. */
  recommended(signal: AbortSignal): Promise<string | undefined>;
  /** Releases whose binary is in the cache. */
  cached(): Promise<string[]>;
  /** The cached binary of `release`, downloaded first when missing. */
  binary(release: string, signal: AbortSignal): Promise<string>;
}
export type ChildExit =
  | { readonly code: number }
  | { readonly signal: string }
  | { readonly startError: string };
export interface RunningChild {
  /** Settles once, when the child has ended; never rejects. */
  readonly exited: Promise<ChildExit>;
  /** SIGTERM; nothing once it has ended. */
  stop(): void;
  /** SIGKILL; nothing once it has ended. */
  kill(): void;
}
export interface ChildProcesses {
  start(request: {
    readonly command: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  }): RunningChild;
}
export interface DeploymentStore {
  /** The file's text; undefined when there is none. */
  read(path: string): Promise<string | undefined>;
  /** Replaces the file whole with text only its owner can read (600), creating its directory (700). */
  writePrivate(path: string, text: string): Promise<void>;
  /** Whether the path is missing or an empty directory. */
  vacant(path: string): Promise<boolean>;
  /** Copies a directory tree to the vacant `to` as a whole, following symbolic links. */
  copyDirectory(from: string, to: string): Promise<void>;
  ensureDirectory(path: string): Promise<void>;
}
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}
export interface Dependencies {
  releases: BackendReleases;
  children: ChildProcesses;
  files: DeploymentStore;
  /** Runs a short command (the backend's keygen) and returns its output. */
  run(request: {
    command: readonly string[];
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<CommandResult>;
  /** The text a loopback GET answers with a 2xx status; undefined otherwise. */
  probe(url: string, signal: AbortSignal): Promise<string | undefined>;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  wait(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  /** 32 random bytes as hex, as `convex dev --local` makes an instance secret. */
  newInstanceSecret(): string;
  output: { write(text: string): void; error(text: string): void };
}

// ---------------------------------------------------------------------------------------------------------------------
// The run

/** How long the backend may take to answer after it starts; Rig's `ready_timeout` bounds the whole start as well. */
export const BACKEND_START_MS = 120_000;
const BACKEND_POLL_MS = 250;
/** A stop of the Service's process group reaches the children and this process at once; a child's exit can be seen
 * first. An exit this close before a stop is part of the stop. */
const STOP_SETTLE_MS = 100;
/** How long a child may take to end after this script (not the supervisor) stopped it; then it is killed. */
export const CHILD_STOP_MS = 10_000;
/** `convex dev` is the Project's own Convex CLI, through bunx. */
const CONVEX_DEV = ["bunx", "convex", "dev"] as const;

/** Runs the deployment until it ends or `stop` aborts. Returns 0 after a requested stop, whatever it interrupted;
 * otherwise the exit code of the child that ended first (at least 1). Throws HelperError, having stopped any child it
 * started, when the deployment cannot be opened, the backend cannot be obtained, or it does not come up. */
export async function runDeployment(
  request: ConvexRunRequest,
  deps: Dependencies,
  stop: AbortSignal,
): Promise<number> {
  try {
    return await runUntilEnd(request, deps, stop);
  } catch (error) {
    // A download, keygen or wait that a stop cut short is the stop, not a failure.
    if (stop.aborted) return 0;
    throw error;
  }
}
async function runUntilEnd(
  request: ConvexRunRequest,
  deps: Dependencies,
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
  const opened = await openDeployment(request, offer, deps, stop);
  if (stop.aborted) return 0;
  const backend = await obtainBackend(opened.backendVersion, offer, deps, stop);
  if (stop.aborted) return 0;
  const deployment = hasOwnCredentials(opened)
    ? opened
    : await newCredentials(
        opened,
        await keygenBinary(backend, offer, deps, stop),
        request.stateDir,
        deps,
        stop,
      );
  const url = backendUrl(request.cloudPort);
  // Only what answers after the backend starts can be taken for it, so nothing may answer before.
  const before = await deps.probe(`${url}/instance_name`, stop);
  if (before !== undefined)
    throw new HelperError(
      "CONVEX_PORT_TAKEN",
      `A Convex backend (${evidence(before) || "unnamed"}) already answers at ${url}, before this Service started its own.`,
      "Stop the other backend (an earlier one of this deployment may still run), or give this Service other ports.",
      { url },
    );
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
    if (started !== "up")
      return (await stopFollows(deps, stop))
        ? 0
        : failed("The Convex backend", started, deps);
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
    return first && !(await stopFollows(deps, stop))
      ? failed(first.label, first.exit, deps)
      : 0;
  } finally {
    await endChildren(children, deps, stop);
  }
}

/** The deployment kept in the state directory; else one `convex dev --local` left in the workspace, copied there first;
 * else a new one. */
async function openDeployment(
  request: ConvexRunRequest,
  offer: { pinned?: string; recommended?: string },
  deps: Dependencies,
  stop: AbortSignal,
): Promise<DeploymentConfig> {
  const own = deploymentFiles(request.stateDir).config;
  const kept = await deps.files.read(own);
  if (kept !== undefined) return parseDeploymentConfig(kept, own);
  // Files without a config could be a database whose secret is lost; a new deployment over them would hide that.
  if (!(await deps.files.vacant(request.stateDir)))
    throw new HelperError(
      "CONVEX_STATE_INCOMPLETE",
      `${request.stateDir} holds files but no config.json, so it is not a Convex deployment this script can run or replace.`,
      "Restore its config.json, or move the directory aside to start a new, empty deployment.",
      { path: request.stateDir },
    );
  const local = join(request.workspace, ".convex", "local", "default");
  const left = await deps.files.read(deploymentFiles(local).config);
  if (left !== undefined) {
    const deployment = parseDeploymentConfig(
      left,
      deploymentFiles(local).config,
    );
    await deps.files.copyDirectory(local, request.stateDir);
    // The copy keeps the source's modes; its secrets are made private to the owner again.
    await deps.files.writePrivate(
      deploymentFiles(request.stateDir).config,
      left,
    );
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
  deps: Dependencies,
  stop: AbortSignal,
): Promise<DeploymentConfig> {
  const release = newDeploymentRelease({
    ...offer,
    cached:
      offer.pinned || offer.recommended ? [] : await deps.releases.cached(),
  });
  if (!release)
    throw new HelperError(
      "CONVEX_BACKEND_UNAVAILABLE",
      "No Convex backend release could be chosen for a new deployment: version.convex.dev did not answer, and Convex's binary cache (~/.cache/convex/binaries) holds no backend.",
      "Start the Service again with a network connection, or fill the cache by running bunx convex dev --local once, or set CONVEX_BACKEND_VERSION to a release to download.",
    );
  const { release: chosen, binary } = await newDeploymentBackend(
    release,
    offer,
    deps,
    stop,
  );
  const instanceSecret = deps.newInstanceSecret();
  const deployment: Deployment = {
    deploymentName: request.instanceName,
    backendVersion: chosen,
    adminKey: await adminKey(
      binary,
      request.instanceName,
      instanceSecret,
      deps,
      stop,
    ),
    instanceSecret,
  };
  await deps.files.ensureDirectory(request.stateDir);
  await deps.files.writePrivate(
    deploymentFiles(request.stateDir).config,
    `${JSON.stringify(deployment, null, 2)}\n`,
  );
  deps.output.write(
    `Created Convex deployment ${deployment.deploymentName} (backend ${chosen}) in ${request.stateDir}\n`,
  );
  return deployment;
}
/** The binary a new deployment starts on: the chosen release, or when that cannot be obtained and was not pinned, the
 * newest release already in the cache. */
async function newDeploymentBackend(
  release: string,
  offer: { pinned?: string },
  deps: Dependencies,
  stop: AbortSignal,
): Promise<{ release: string; binary: string }> {
  try {
    return { release, binary: await deps.releases.binary(release, stop) };
  } catch (error) {
    if (stop.aborted || offer.pinned) throw error;
    const cached = newDeploymentRelease({
      cached: (await deps.releases.cached()).filter((each) => each !== release),
    });
    if (!cached) throw error;
    deps.output.error(
      `Starting on the cached Convex backend ${cached}: ${errorMessage(error)}\n`,
    );
    return {
      release: cached,
      binary: await deps.releases.binary(cached, stop),
    };
  }
}
/** The binary to make new credentials with. Like `convex dev`, the newest to hand: under a pin, a newer cached release
 * (an older one may not have `keygen admin-key`), else the binary the deployment runs on. */
async function keygenBinary(
  backend: { release: string; binary: string },
  offer: { pinned?: string },
  deps: Dependencies,
  stop: AbortSignal,
): Promise<string> {
  if (!offer.pinned) return backend.binary;
  const newest = newDeploymentRelease({ cached: await deps.releases.cached() });
  return newest && releasedBefore(backend.release, newest)
    ? await deps.releases.binary(newest, stop)
    : backend.binary;
}
/** New credentials for a deployment an older Convex CLI made without its own, saved before the backend runs on them. */
async function newCredentials(
  config: DeploymentConfig,
  binary: string,
  stateDir: string,
  deps: Dependencies,
  stop: AbortSignal,
): Promise<Deployment> {
  const instanceSecret = deps.newInstanceSecret();
  const deployment: Deployment = {
    ...config,
    instanceSecret,
    adminKey: await adminKey(
      binary,
      config.deploymentName,
      instanceSecret,
      deps,
      stop,
    ),
  };
  await deps.files.writePrivate(
    deploymentFiles(stateDir).config,
    `${JSON.stringify(deployment, null, 2)}\n`,
  );
  deps.output.write(
    `Made the Convex deployment ${deployment.deploymentName} an instance secret and admin key of its own, as convex dev does for a deployment an older Convex CLI made.\n`,
  );
  return deployment;
}
/** The admin key for one instance name and secret, made by the backend's own `keygen`. */
async function adminKey(
  binary: string,
  name: string,
  secret: string,
  deps: Dependencies,
  stop: AbortSignal,
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
    signal: stop,
  });
  const key = result.stdout.trim();
  if (result.exitCode === 0 && key) return key;
  const why = lastLine(result.stderr);
  throw new HelperError(
    "CONVEX_KEYGEN",
    `The Convex backend could not make an admin key for ${name}${result.timedOut ? " in 30 s" : ""}${why ? ` (${evidence(why)})` : ""}.`,
    "Check the backend binary with --help; delete its directory in ~/.cache/convex/binaries to download it again.",
    { binary, ...(why ? { evidence: evidence(why) } : {}) },
  );
}
/** The binary to run and its release: the next release when it can be obtained, else the deployment's own. */
async function obtainBackend(
  current: string,
  offer: { pinned?: string; recommended?: string },
  deps: Dependencies,
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
    if (stop.aborted) throw error;
    deps.output.error(
      `Staying on Convex backend ${fallback}: ${errorMessage(error)}\n`,
    );
    return {
      release: fallback,
      binary: await deps.releases.binary(fallback, stop),
    };
  }
}
/** Waits for the backend to answer with this deployment's name: `up`, `stopped` when a stop came first, or how the
 * backend ended. */
async function backendAnswers(
  input: { url: string; name: string; server: RunningChild },
  deps: Dependencies,
  stop: AbortSignal,
): Promise<"up" | "stopped" | ChildExit> {
  let ended: ChildExit | undefined;
  void input.server.exited.then((exit) => (ended = exit));
  const deadline = deps.now() + BACKEND_START_MS;
  for (;;) {
    if (stop.aborted) return "stopped";
    const answer = await deps.probe(`${input.url}/instance_name`, stop);
    if (answer === input.name) {
      // A backend that failed to bind the port ends at once; one more poll interval shows it.
      await deps.wait(BACKEND_POLL_MS, stop);
      if (stop.aborted) return "stopped";
      return ended ?? "up";
    }
    if (stop.aborted) return "stopped";
    if (ended) return ended;
    if (answer !== undefined)
      throw new HelperError(
        "CONVEX_PORT_TAKEN",
        `Another Convex backend (${evidence(answer) || "unnamed"}) answers at ${input.url}.`,
        "Stop the other backend, or give this Service other ports.",
        { url: input.url },
      );
    if (deps.now() >= deadline)
      throw new HelperError(
        "CONVEX_BACKEND_START",
        `The Convex backend did not answer at ${input.url} within ${BACKEND_START_MS / 1000} s.`,
        "Read the backend's own output above this line in the Target log.",
        { url: input.url },
      );
    await deps.wait(BACKEND_POLL_MS, stop);
  }
}
/** Records a release the backend has started on, so the next start does not take it for an upgrade again. */
async function recordRelease(
  stateDir: string,
  deployment: Deployment,
  release: string,
  deps: Dependencies,
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
/** Stops the children and waits for them. When this script stopped them itself (a child ended, or starting failed), one
 * that does not end within CHILD_STOP_MS is killed. A stop the supervisor asked for is waited out: its stop_timeout
 * bounds it. */
async function endChildren(
  children: readonly RunningChild[],
  deps: Dependencies,
  stop: AbortSignal,
): Promise<void> {
  for (const child of children) child.stop();
  const ended = Promise.all(children.map((child) => child.exited));
  if (!stop.aborted) {
    const timer = new AbortController();
    const inTime = await Promise.race([
      ended.then(() => true),
      deps.wait(CHILD_STOP_MS, timer.signal).then(() => false),
    ]);
    timer.abort();
    if (!inTime) {
      deps.output.error(
        `A child of the Convex Service did not stop within ${CHILD_STOP_MS / 1000} s of SIGTERM; killing it.\n`,
      );
      for (const child of children) child.kill();
    }
  }
  await ended;
}
async function stopFollows(
  deps: Dependencies,
  stop: AbortSignal,
): Promise<boolean> {
  if (!stop.aborted) await deps.wait(STOP_SETTLE_MS, stop);
  return stop.aborted;
}
/** Says how a child ended by itself and returns the exit code for it: never 0, since nothing asked it to end. */
function failed(label: string, exit: ChildExit, deps: Dependencies): number {
  const how =
    "code" in exit
      ? `exited with code ${exit.code}`
      : "signal" in exit
        ? `ended by ${exit.signal}`
        : `could not start (${exit.startError})`;
  deps.output.error(`${label} ${how}; stopping the Convex Service.\n`);
  return "code" in exit && exit.code !== 0 ? exit.code : 1;
}

// ---------------------------------------------------------------------------------------------------------------------
// The real dependencies

export const RELEASE_SOURCES = {
  recommended: "https://version.convex.dev/v1/local_backend_version",
  downloads: "https://github.com/get-convex/convex-backend/releases/download",
};
const EXECUTABLE = "convex-local-backend";
const LOOKUP_MS = 5_000;
/** How long one backend download may take: well inside the recipe's 3 minute ready_timeout. */
const DOWNLOAD_MS = 120_000;

/** Convex's releases through the cache `convex dev` uses: <home>/.cache/convex/binaries/<release>/convex-local-backend.
 * A download is unpacked beside the cache and moved in whole, so a half-written binary is never found there. */
export function backendReleases(input: {
  home: string;
  platform: NodeJS.Platform;
  arch: string;
  /** PATH for `unzip`. */
  PATH: string | undefined;
  sources?: { recommended: string; downloads: string };
}): BackendReleases {
  const cache = join(input.home, ".cache", "convex", "binaries");
  const sources = input.sources ?? RELEASE_SOURCES;
  const binaryOf = (release: string) => join(cache, release, EXECUTABLE);
  return {
    async recommended(signal) {
      try {
        const response = await fetch(sources.recommended, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(LOOKUP_MS)]),
        });
        if (!response.ok) return undefined;
        const answer = (await response.json()) as { version?: unknown };
        return typeof answer.version === "string" &&
          RELEASE_NAME.test(answer.version)
          ? answer.version
          : undefined;
      } catch {
        return undefined;
      }
    },
    async cached() {
      let names: string[];
      try {
        names = await readdir(cache);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new HelperError(
          "CONVEX_CACHE",
          `Convex's binary cache ${cache} cannot be read (${errorMessage(error)}).`,
          `Fix the permissions of ${cache} (it should be yours and readable), then start the Service again.`,
          { path: cache },
        );
      }
      const found = await Promise.all(
        names.map(async (name) =>
          RELEASE_NAME.test(name) && (await executable(binaryOf(name)))
            ? name
            : undefined,
        ),
      );
      return found.filter((name) => name !== undefined);
    },
    async binary(release, signal) {
      if (!RELEASE_NAME.test(release))
        throw new HelperError(
          "CONVEX_BACKEND_DOWNLOAD",
          `'${evidence(release)}' is not a Convex backend release name.`,
          "Use a release such as precompiled-2026-09-21-0cf49cb, as named in ~/.cache/convex/binaries.",
        );
      const binary = binaryOf(release);
      if (await executable(binary)) return binary;
      const asset = assetName(input.platform, input.arch);
      const url = `${sources.downloads}/${release}/${asset}`;
      const failure = (reason: string) =>
        new HelperError(
          "CONVEX_BACKEND_DOWNLOAD",
          `Convex backend ${release} is not in ${cache} and could not be downloaded (${evidence(reason)}).`,
          "Start the Service again with a network connection, or set CONVEX_BACKEND_VERSION to a release already in that directory.",
          { release, url },
        );
      let staging: string | undefined;
      try {
        await mkdir(cache, { recursive: true });
        staging = await mkdtemp(join(cache, `.rig-${release}-`));
        // A stalled download gives up on its own, in time for the start to fall back to a cached release.
        const response = await fetch(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_MS)]),
        });
        if (!response.ok) throw failure(`HTTP ${response.status} from ${url}`);
        const archive = join(staging, asset);
        await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
        const unpacked = await runCommand({
          command: ["unzip", "-o", "-q", archive, "-d", staging],
          timeoutMs: DOWNLOAD_MS,
          signal,
          ...(input.PATH === undefined ? {} : { env: { PATH: input.PATH } }),
        }).catch((error: unknown) => {
          throw failure(
            `unzip could not run: ${errorMessage(error)}; it must be on PATH`,
          );
        });
        if (unpacked.exitCode !== 0)
          throw failure(
            `unzip failed: ${lastLine(unpacked.stderr) ?? `exit code ${unpacked.exitCode}`}`,
          );
        const staged = join(staging, EXECUTABLE);
        if (!(await exists(staged)))
          throw failure(`the archive has no ${EXECUTABLE}`);
        await chmod(staged, 0o755);
        await mkdir(join(cache, release), { recursive: true });
        await rename(staged, binary);
        return binary;
      } catch (error) {
        throw error instanceof HelperError
          ? error
          : failure(errorMessage(error));
      } finally {
        if (staging) await rm(staging, { recursive: true, force: true });
      }
    },
  };
}
/** The archive Convex publishes for this platform. */
export function assetName(platform: NodeJS.Platform, arch: string): string {
  const cpu = ({ arm64: "aarch64", x64: "x86_64" } as Record<string, string>)[
    arch
  ];
  const system = (
    { darwin: "apple-darwin", linux: "unknown-linux-gnu" } as Record<
      string,
      string
    >
  )[platform];
  if (!cpu || !system)
    throw new HelperError(
      "CONVEX_PLATFORM",
      `Convex publishes no local backend for ${platform} on ${arch}.`,
      "Run the Service on a Mac or on Linux, on arm64 or x64.",
      { platform, arch },
    );
  return `convex-local-backend-${cpu}-${system}.zip`;
}
async function executable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Children that stay in this process's group (a stop or kill of the Service's group reaches them, and Rig's listener
 * check sees their sockets), with no stdin and this process's stdout and stderr, which Rig records. */
export function childProcesses(): ChildProcesses {
  return {
    start({ command, cwd, env }) {
      const child = spawn(command[0]!, command.slice(1), {
        cwd,
        env,
        stdio: ["ignore", "inherit", "inherit"],
      });
      let ended = false;
      const exited = new Promise<ChildExit>((resolve) => {
        child.on("error", (error) => {
          // A started child that later fails to be signalled also emits error; only a failed start ends it here.
          if (child.pid !== undefined) return;
          ended = true;
          resolve({ startError: error.message });
        });
        child.once("exit", (code, signal) => {
          ended = true;
          resolve(signal ? { signal } : { code: code ?? 1 });
        });
      });
      const signal = (name: NodeJS.Signals) => {
        if (ended) return;
        try {
          child.kill(name);
        } catch {
          /* It ended between the check and the signal. */
        }
      };
      return {
        exited,
        stop: () => signal("SIGTERM"),
        kill: () => signal("SIGKILL"),
      };
    },
  };
}

/** The local filesystem as a deployment's files. Every failure is CONVEX_FILES, naming the path. */
export function deploymentStore(): DeploymentStore {
  const tagged = async <T>(
    action: string,
    path: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HelperError) throw error;
      throw new HelperError(
        "CONVEX_FILES",
        `rig-convex could not ${action} ${path} (${errorMessage(error)}).`,
        "Check that the path is a directory or file your account owns and can write, on a volume with space, then start the Service again.",
        { path },
      );
    }
  };
  return {
    read: (path) =>
      tagged("read", path, async () => {
        try {
          return await readFile(path, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw error;
        }
      }),
    writePrivate: (target, text) =>
      tagged("write", target, async () => {
        // A symlinked file (a shared .env.local) is written where it points, and stays a link.
        const path = await realpath(target).catch(() => target);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const staged = join(
          dirname(path),
          `.${basename(path)}.${process.pid}.tmp`,
        );
        await writeFile(staged, text, { mode: 0o600 });
        await chmod(staged, 0o600);
        await rename(staged, path);
      }),
    vacant: (path) =>
      tagged("list", path, async () => {
        try {
          return (await readdir(path)).length === 0;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
          throw error;
        }
      }),
    copyDirectory: (from, to) =>
      tagged(`copy ${from} to`, to, async () => {
        await mkdir(dirname(to), { recursive: true, mode: 0o700 });
        // A staging directory of its own, which an interrupted copy leaves behind instead of a partial `to`.
        const staging = await mkdtemp(`${to}.rig-copy-`);
        try {
          await cp(from, join(staging, "tree"), {
            recursive: true,
            // A linked file is copied as the file it names, so the copy does not depend on where the link pointed.
            dereference: true,
            errorOnExist: true,
            force: false,
            preserveTimestamps: true,
          });
          await chmod(join(staging, "tree"), 0o700);
          // rename replaces an empty directory and refuses one with entries.
          await rename(join(staging, "tree"), to);
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      }),
    ensureDirectory: (path) =>
      tagged("create", path, async () => {
        await mkdir(path, { recursive: true, mode: 0o700 });
      }),
  };
}

/** Runs a short command and returns its output; the whole process group is killed past its budget or on `signal`. */
export async function runCommand(request: {
  command: readonly string[];
  timeoutMs: number;
  signal: AbortSignal;
  env?: Record<string, string>;
}): Promise<CommandResult> {
  request.signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn(request.command[0]!, request.command.slice(1), {
      ...(request.env ? { env: request.env } : {}),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timedOut = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already ended. */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, request.timeoutMs);
    request.signal.addEventListener("abort", kill, { once: true });
    const done = () => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", kill);
    };
    child.stdout.on("data", (data) => (stdout += String(data)));
    child.stderr.on("data", (data) => (stderr += String(data)));
    child.on("error", (error) => {
      done();
      reject(error);
    });
    child.on("close", (code) => {
      done();
      if (request.signal.aborted)
        reject(new Error("The command was cancelled."));
      else
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          ...(timedOut ? { timedOut } : {}),
        });
    });
  });
}

/** The body of a GET that answers with a 2xx status; undefined when nothing answers in time or the status is another. */
export async function probeText(
  url: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
    });
    return response.ok ? await response.text() : undefined;
  } catch {
    return undefined;
  }
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry point

/** Signals that ask the Service to stop. Rig sends SIGTERM to the Service's process group, so the children get it too;
 * the script still passes it on and waits for both. */
const STOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export async function main(): Promise<number> {
  const output = {
    write: (text: string) => void process.stdout.write(text),
    error: (text: string) => void process.stderr.write(text),
  };
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  try {
    const request = readSettings(
      process.env,
      process.argv.slice(2),
      process.cwd(),
    );
    return await runDeployment(
      request,
      {
        releases: backendReleases({
          home: homedir(),
          platform: process.platform,
          arch: process.arch,
          PATH: process.env.PATH,
          sources: {
            recommended:
              process.env.CONVEX_BACKEND_VERSION_URL ||
              RELEASE_SOURCES.recommended,
            downloads:
              process.env.CONVEX_BACKEND_DOWNLOAD_URL ||
              RELEASE_SOURCES.downloads,
          },
        }),
        children: childProcesses(),
        files: deploymentStore(),
        run: runCommand,
        probe: probeText,
        wait,
        now: Date.now,
        newInstanceSecret: () => randomBytes(32).toString("hex"),
        output,
      },
      stop.signal,
    );
  } catch (error) {
    if (error instanceof HelperError)
      output.error(
        `rig-convex: ${error.message} (${error.code})\n${error.hint}\n`,
      );
    else
      output.error(
        `rig-convex: ${errorMessage(error)}\nThe output above this line shows what it was doing.\n`,
      );
    return 1;
  } finally {
    for (const signal of STOP_SIGNALS) process.removeListener(signal, onSignal);
  }
}

if (import.meta.main) process.exitCode = await main();

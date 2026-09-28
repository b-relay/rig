import { join } from "node:path";
import { z } from "zod";
import { RigError, describeInvalidDocument } from "../domain/errors";

/** A Convex backend release as Convex names it (`precompiled-2026-09-21-0cf49cb`). It also names a directory of Convex's
 * binary cache, so it may not hold a path separator or start with a dot. */
export const backendRelease = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    "must be a Convex backend release name such as precompiled-2026-09-21-0cf49cb",
  );
/** A deployment's `config.json`, in the form `convex dev --local` writes to `.convex/local/default/config.json`. Fields
 * Rig does not use, such as `ports` and `cloudProjectId`, are kept when the file is written back. An older Convex CLI
 * wrote no instance secret (the backend then used a fixed legacy one), and so possibly no admin key either. */
export const deploymentConfig = z.looseObject({
  deploymentName: z.string().min(1),
  backendVersion: backendRelease,
  adminKey: z.string().min(1).optional(),
  instanceSecret: z.string().min(1).optional(),
});
export type DeploymentConfig = z.infer<typeof deploymentConfig>;
/** A deployment with credentials of its own, which is what the backend is started with. */
export type Deployment = DeploymentConfig & {
  adminKey: string;
  instanceSecret: string;
};
/** The instance secret every local backend shared before the Convex CLI made one per deployment. */
const LEGACY_INSTANCE_SECRET =
  "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
/** Whether the deployment has credentials of its own. One without, or with the legacy secret, gets new ones before it
 * runs, as `convex dev --local` does; its data does not depend on them. */
export function hasOwnCredentials(
  config: DeploymentConfig,
): config is Deployment {
  return (
    config.adminKey !== undefined &&
    config.instanceSecret !== undefined &&
    config.instanceSecret !== LEGACY_INSTANCE_SECRET
  );
}

/** The files of one deployment directory. The layout is the one `convex dev --local` uses, so a directory it made can be
 * run here and the other way round. */
export function deploymentFiles(stateDir: string) {
  return {
    config: join(stateDir, "config.json"),
    storage: join(stateDir, "convex_local_storage"),
    database: join(stateDir, "convex_local_backend.sqlite3"),
  };
}
/** Pure: the deployment a `config.json` holds. Throws CONVEX_STATE_INVALID naming the file and the first problem. */
export function parseDeploymentConfig(
  text: string,
  path: string,
): DeploymentConfig {
  let problem: unknown;
  try {
    const parsed = deploymentConfig.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
    problem = parsed.error;
  } catch (error) {
    problem = error;
  }
  throw new RigError(
    "CONVEX_STATE_INVALID",
    `The Convex deployment config ${path} ${describeInvalidDocument(problem, "Convex deployment")}.`,
    "Restore the file from a backup, or move the deployment directory aside to start a new, empty deployment.",
    { path },
  );
}
/** The address the backend serves its API on; the site (HTTP actions) port is its neighbour. */
export function backendUrl(cloudPort: number): string {
  return `http://127.0.0.1:${cloudPort}`;
}
/** Pure: the backend's arguments, bound to loopback. The deployment's secret is an argument because the backend reads it
 * from nowhere else; `convex dev --local` passes it the same way. */
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
/** Release names start with their date (`precompiled-YYYY-MM-DD-<commit>`); true only when both have one and `release` is
 * from an earlier day. */
export function releasedBefore(release: string, than: string): boolean {
  const day = (name: string) => /\d{4}-\d{2}-\d{2}/.exec(name)?.[0];
  const [a, b] = [day(release), day(than)];
  return a !== undefined && b !== undefined && a < b;
}
/** Pure: the release a new deployment starts on: the pinned one, else the one Convex recommends, else (offline) the newest
 * already in Convex's cache. Undefined when there is none of these. */
export function newDeploymentRelease(offer: {
  pinned?: string;
  recommended?: string;
  cached: readonly string[];
}): string | undefined {
  // The dated names sort by day.
  return offer.pinned ?? offer.recommended ?? [...offer.cached].sort().at(-1);
}
/** Pure: the release an existing deployment runs next. Like `convex dev`, it moves to the recommended release when that is
 * not older; the new backend migrates the data when it starts. `fallback` is the deployment's own release, to run when the
 * newer one cannot be obtained. A pinned release is run as asked, with no fallback. */
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

/** Lines of `.env.local` that point `bunx convex` at a self-hosted backend: this helper's, or a hand-written script's. */
const MANAGED_LINE =
  /^(?:CONVEX_SELF_HOSTED_URL|CONVEX_SELF_HOSTED_ADMIN_KEY)=|^# Convex backend run by /;
/** The deployment `convex dev` would otherwise use, which the Convex CLI refuses beside the self-hosted pair. */
const OTHER_DEPLOYMENT = /^CONVEX_DEPLOYMENT=/;
const HEADER = "# Convex backend run by rigd convex (the convex recipe)";
const SET_ASIDE = "  # set aside by rigd convex";
/** Pure: `.env.local` with the self-hosted pair pointing at this backend. A `CONVEX_DEPLOYMENT` line is commented out
 * rather than removed, so a cloud deployment it named is not lost; every other line is kept, in order. The pair and its
 * comment go last. */
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
/** Pure: `convex dev`'s environment. The self-hosted pair is set here as well as in `.env.local`, because a variable a
 * parent loaded from an older `.env.local` would otherwise win over the file; `CONVEX_DEPLOYMENT` is removed for the
 * same reason. */
export function convexDevEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  input: { url: string; adminKey: string },
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment))
    if (value !== undefined && key !== "CONVEX_DEPLOYMENT") result[key] = value;
  result.CONVEX_SELF_HOSTED_URL = input.url;
  result.CONVEX_SELF_HOSTED_ADMIN_KEY = input.adminKey;
  return result;
}
/** Pure: the backend's environment. TZ is left out: the backend panics at startup when TZ is set ("Convex requires
 * UTC"), and Rig passes Services the TZ of the shell that installed rigd. Its own request logs are left out unless
 * RUST_LOG asks for them: `convex dev` tails the function logs, which are the ones worth reading in the Target log. */
export function backendEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment))
    if (value !== undefined && key !== "TZ") result[key] = value;
  result.RUST_LOG ??= "warn";
  return result;
}

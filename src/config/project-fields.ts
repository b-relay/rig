import { z } from "zod";
import { validHostname } from "./hostname";
import {
  REFERENCE_VARIABLE_PREFIX,
  RESERVED_NAME_RULE,
  unrepresentableValue,
} from "../domain/process-environment";
import { MAX_STOP_TIMEOUT_SECONDS } from "../domain/stop-budget";
import {
  HEALTHCHECK_DEFAULTS,
  MIN_HEALTHCHECK_INTERVAL_SECONDS,
  healthcheckListProblem,
  isHealthUrl,
} from "./healthcheck";
import { isTimeZone, parseCron } from "../domain/cron";
import { keyedMap } from "./keyed-map";
import {
  MAX_NAME_LENGTH,
  NAME_CHARACTERS,
  NAME_LENGTH,
  NAME_PATTERN,
} from "../domain/names";

// The documented fields of rig.yaml, each with the description an editor shows beside it. Rules that span fields are in
// project-rules.ts, and the guidance for retired keys in retired-keys.ts.
const text = z.string().min(1);
/** A Project or Preview name as config, the control plane and the editors accept it. */
export const nameSchema = z
  .string()
  .min(1)
  .max(MAX_NAME_LENGTH, NAME_LENGTH)
  .regex(NAME_PATTERN, NAME_CHARACTERS);
const name = nameSchema.describe(
  `Stable registered Project name, at most ${MAX_NAME_LENGTH} characters. It names the Project's operator env directory under <RIG_ROOT>/env, so no two Projects on a Host may have names that differ only in case. Change it with rig rename.`,
);
const entryName = text
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "must start with a lowercase letter or digit and contain only lowercase letters, digits or '-'",
  )
  .describe(
    "Service or Tool name used in references, dependencies and output.",
  );
/** Validates explicit bind flags, descending into quoted sub-commands such as `sh -c "..."`;
 * ordinary command URL arguments may reference remote services. */
export function localhostCommand(value: string): boolean {
  const tokens = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const quoted = /^(["']).*\1$/.test(tokens[i]!) && tokens[i]!.length > 1;
    const token = tokens[i]!.replace(/^['"]|['"]$/g, "");
    if (quoted && /\s/.test(token) && !localhostCommand(token)) return false;
    const match =
      /^--(?:host|hostname|bind|bind-host|listen|listen-host|addr|address)(?:=(.+))?$/.exec(
        token,
      );
    if (match) {
      const host = (match[1] ?? tokens[++i] ?? "")
        .replace(/^['"]|['"]$/g, "")
        .replace(/:\d+$/, "");
      if (!["localhost", "127.0.0.1"].includes(host)) return false;
    }
  }
  return !/(?:^|[\s='"])(?:0\.0\.0\.0|\[?::\]?)(?=[:\s'"]|$)/.test(value);
}
/** Env keys servers commonly read for their bind address; a wildcard there opens the process to the network as surely as a flag. */
const BIND_KEY =
  /^(?:HOST|HOSTNAME|BIND|BIND_ADDR|BIND_ADDRESS|BIND_HOST|LISTEN|LISTEN_ADDR|LISTEN_ADDRESS|LISTEN_HOST|ADDR|ADDRESS)$/;
const WILDCARD_ADDRESS = /^(?:0\.0\.0\.0|\[::\]|::)(?::\d+)?$/;
type ReferenceScope = "project" | "service" | "job";
/** The one owner of the reference list an editor shows on hover; the long form is "References" in docs/rig-guide.md.
 * ${rig.data} is one Service's or job's own directory, so only their own fields offer it. */
const referencesIn = (scope: ReferenceScope) =>
  `References: ${scope === "service" ? "${port} (this Service's only port), ${ports.<port>} (one of its named ports), " : ""}\${environment.NAME}, \${services.<service>.port} (a Service's only port), \${services.<service>.ports.<port>}, \${services.<service>.data} (a Service's persistent directory), a scalar setting by its path such as \${services.api.stop_timeout}, \${rig.target}, \${rig.workspace}, \${rig.host}, \${rig.url}${scope === "service" ? ", ${rig.data}" : scope === "job" ? ", ${rig.data} (this job's own persistent directory)" : ""}. $\${VAR} writes a literal \${VAR}.`;
/** Where a reference in a shell command is refused. */
const SHELL_REFERENCES =
  "A referenced value reaches the command through a _RIG_ variable as one word, never as shell code. A reference in a command with arithmetic, [[ ]], a subscript or let, declare, read and the like, in or after a heredoc, or in $'...' is refused: declare such a value in environment and read $NAME instead.";
const command = text
  .refine(
    (value) => localhostCommand(value.replace(/\$\{[^}]+\}/g, "1234")),
    "Explicit network bindings must use 127.0.0.1 or localhost.",
  )
  .describe(
    `Shell command run with /bin/sh -c; explicit bindings must be localhost only. ${SHELL_REFERENCES}`,
  );
/** A health URL must parse as a whole, carry no userinfo, and address 127.0.0.1 or localhost; a shell health command follows the command rule. */
export function localhostHealth(value: string): boolean {
  if (!isHealthUrl(value)) return localhostCommand(value);
  try {
    const url = new URL(value);
    return (
      url.username === "" &&
      url.password === "" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
/** The one hostname substitution: the actual Target name, which is always a single valid label. */
const TARGET_REFERENCE = "${rig.target}";
const DOMAIN_REFERENCE = `${TARGET_REFERENCE} is the only reference a hostname may contain.`;
const domain = text
  .refine(
    (value) =>
      !value.replaceAll(TARGET_REFERENCE, "").includes("${") &&
      validHostname(value.replaceAll(TARGET_REFERENCE, "target")),
    "must be a hostname such as app.test or ${rig.target}.app.test; schemes, ports, paths, wildcards, lists and other references are not allowed",
  )
  .describe(`Single hostname. ${DOMAIN_REFERENCE}`);
const DURATION_UNITS = { s: 1, m: 60, h: 3600 } as const;
/** Whole seconds of a validated duration such as 30s, 10m or 1h. */
export function durationSeconds(value: string): number {
  const match = /^([1-9]\d{0,5})(s|m|h)$/.exec(value);
  return match
    ? Number(match[1]) * DURATION_UNITS[match[2] as keyof typeof DURATION_UNITS]
    : Number.NaN;
}
/** One day is the most a timer can be asked to hold without overflowing. */
const duration = text.refine((value) => {
  const seconds = durationSeconds(value);
  return seconds >= 1 && seconds <= 86400;
}, "must be a positive duration of at most one day, such as 30s, 10m or 1h");
/** A Service's stop grace: at least one second, at most one hour. */
const stopTimeout = text
  .refine((value) => {
    const seconds = durationSeconds(value);
    return seconds >= 1 && seconds <= MAX_STOP_TIMEOUT_SECONDS;
  }, "must be a duration from 1s to 1h, such as 10s, 2m or 1h")
  .describe(
    "How long the Service may take to exit after its stop signal (SIGTERM) before Rig ends it with SIGKILL, such as 2m (default 10s, at most 1h). Every stop waits for it: rig down, rig restart, a deploy that replaces or rolls back the Target, a Preview destroy, and the stop of a failed start. rig down --kill skips it.",
  );
const envName = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "must be an environment variable name: letters, digits and '_', not starting with a digit",
  )
  .refine(
    (name) => !name.startsWith(REFERENCE_VARIABLE_PREFIX),
    `is not available: ${RESERVED_NAME_RULE}`,
  );
/** Public inline environment; only wildcard addresses under bind-style keys are rejected, since HOST may also name a public hostname. */
const environmentMap = (scope: ReferenceScope) =>
  keyedMap(
    envName,
    z
      .string()
      .describe(
        `Public value. It reaches the process exactly, so a NUL character or an unpaired surrogate is refused. ${referencesIn(scope)}`,
      ),
    "an environment variable name",
  ).superRefine((env, ctx) => {
    for (const [key, value] of Object.entries(env)) {
      if (BIND_KEY.test(key) && WILDCARD_ADDRESS.test(value.trim()))
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} must bind to 127.0.0.1 or localhost, not a wildcard address.`,
        });
      const unrepresentable = unrepresentableValue(value);
      if (unrepresentable)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} holds ${unrepresentable}.`,
        });
    }
  });
const env = (scope: ReferenceScope) =>
  environmentMap(scope).describe(
    "Public environment values passed to the process; never put secrets here. Names may not start with _RIG_, which Rig reserves. Values may use ${...} references. Bind-style keys such as HOST or BIND_ADDR may not use a wildcard address.",
  );
const envFile = (scope: ReferenceScope) =>
  z
    .union([text, z.array(text).min(1)])
    .describe(
      `Environment file path, or an ordered list of paths where later files win. Listed files are required and hold plain KEY=value data; their contents never take part in \${...} references. Relative paths resolve against the workspace root, never against a Service's working_dir; ~ is the operator home. The path itself may use references. ${referencesIn(scope)}`,
    );
const buildRule = (where: string) =>
  `run with /bin/sh -c ${where} during preparation, never as a start hook; explicit bindings must be localhost only. ${SHELL_REFERENCES}`;
/** A shared or Tool build runs with Project inputs only. */
const PROJECT_BUILD_REFERENCES = `${referencesIn("project")} A Service's environment is not available here.`;
const build = command.describe(
  `Shell build command ${buildRule("in the workspace")} ${PROJECT_BUILD_REFERENCES}`,
);
const buildTimeout = duration.describe(
  "Build duration budget such as 10m; a build past it is terminated and recorded as failed, never as completed.",
);
const portName = text
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "must start with a lowercase letter or digit and contain only lowercase letters, digits or '-'",
  )
  .describe(
    "Port name used in ${ports.<port>} and ${services.<service>.ports.<port>} references. A Service with exactly one port can also be referenced as ${port} in its own settings and as ${services.<service>.port} anywhere.",
  );
const ports = keyedMap(
  portName,
  z.union([z.literal("auto"), z.number().int().min(1).max(65535)]),
  "a port name",
).describe(
  "Named local TCP ports: auto lets Rig choose and keep a free port, a number from 1 to 65535 pins it. Previews always use chosen ports.",
);
/** A Service's own hostname: a hostname, or a hostname with the port it reaches. */
const serviceDomain = z
  .union([
    domain,
    z.strictObject({
      host: domain.describe(
        `The hostname, written as in domain. ${DOMAIN_REFERENCE}`,
      ),
      port: portName
        .optional()
        .describe(
          "The name of the port under ports this hostname reaches, such as http. Needed only when the Service declares several ports.",
        ),
    }),
  ])
  .describe(
    `A hostname of its own for this Service, such as api.app.example.com, beside the Project domain: every request to it, at any path, reaches this Service's only port. A Service with several ports names one: domain: { host: api.app.example.com, port: http }. It follows the domain rule per Target: the stable Target serves it as written, a Preview with a dash and its name after the first label (api-<preview-name>.app.example.com), and the working Target only when targets.working sets it. Under targets.preview it replaces the host for every Preview, so include \${rig.target}, such as \${rig.target}.api.preview.example.com. Every hostname of one Target must differ. ${DOMAIN_REFERENCE}`,
  );
const restart = z
  .enum(["always", "on-failure", "no"])
  .describe(
    "Automatic restart after a known exit: always (default), on-failure, or no. An explicit up or restart starts the Service under every policy.",
  );
/** A directory inside the workspace, written relative to it: no absolute path, no ~, no '..' segment and no reference, so
 * it can never name a directory outside the checkout a Target runs from. */
function insideWorkspace(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.startsWith("~") &&
    !value.includes("${") &&
    !value.split("/").includes("..")
  );
}
const workingDir = text
  .refine(
    insideWorkspace,
    "must be a directory inside the workspace, relative to it, such as apps/web: no absolute path, ~, '..' or reference",
  )
  .describe(
    "Directory the Service's command, its build and its healthcheck command run in, relative to the workspace, such as apps/web (default: the workspace root). It cannot leave the workspace: absolute paths, ~, '..' and references are refused. Relative env_file paths and ${rig.workspace} still mean the workspace root.",
  );
/** One `watch` entry: a path, directory or glob inside the workspace, written relative to its root. Git's own pathspec
 * magic (a leading ':') is refused too, since Rig gives every entry its glob meaning. */
const watchPath = text
  .refine(
    (value) => insideWorkspace(value) && !value.startsWith(":"),
    "must be a path or glob inside the workspace, relative to its root, such as scripts/rig-postgres.sh: no absolute path, ~, '..', reference or leading ':'",
  )
  .describe(
    "A tracked file, a directory (everything under it) or a glob, relative to the workspace root as env_file paths are: * matches within one directory and ** across directories.",
  );
const watch = z
  .array(watchPath)
  .describe(
    "Which checkout files a deploy compares to decide whether this Service restarts; it is not live sync, and nothing watches files while the Service runs. A deploy of a new Commit keeps a running Service running when its settings, environment (env file contents included) and builds are unchanged and none of these files changed since the Commit its process started from; otherwise it restarts it, and every Service that depends on it. Leave it out to compare the whole checkout, so any change restarts the Service; [] when the Service reads nothing from the checkout, such as a database binary installed elsewhere.",
  );
/** A local URL or a command that addresses only 127.0.0.1 or localhost, judged with every reference standing in as a port. */
const localCheck = (value: string) =>
  localhostHealth(value.replace(/\$\{[^}]+\}/g, "1234"));
const LOCAL_CHECK = "Health checks must address 127.0.0.1 or localhost.";
const healthcheckTest = z
  .union([
    text
      .refine(localCheck, LOCAL_CHECK)
      .describe(
        `A shell command run with /bin/sh -c in working_dir that passes on exit 0, as in Compose; a string starting with / is a command too. Rig's one extension: a string starting with http:// or https:// is an HTTP GET of a local URL that passes with a status below 400, without following a redirect. A failed shell command shows its last output line, with every env-file value replaced by [redacted]. ${SHELL_REFERENCES} ${referencesIn("service")}`,
      ),
    z
      .array(z.string())
      .min(1)
      .superRefine((test, ctx) => {
        const problem = healthcheckListProblem(test);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
        else if (test[0] !== "NONE" && !localCheck(test.slice(1).join(" ")))
          ctx.addIssue({ code: "custom", message: LOCAL_CHECK });
      })
      .describe(
        `Compose's list forms: ["CMD-SHELL", "<command>"] runs a shell command; ["CMD", "<program>", "<argument>", ...] runs the program with exactly those arguments, without a shell; ["NONE"] turns the healthcheck off. ${referencesIn("service")}`,
      ),
  ])
  .describe(
    "What one check runs: a shell command, a local http(s) URL, or one of Compose's list forms. Without it, a check passes when every declared port accepts a connection.",
  );
const healthcheck = z
  .strictObject({
    test: healthcheckTest.optional(),
    interval: duration
      .refine(
        (value) => durationSeconds(value) >= MIN_HEALTHCHECK_INTERVAL_SECONDS,
        `must be at least ${MIN_HEALTHCHECK_INTERVAL_SECONDS}s`,
      )
      .optional()
      .describe(
        `Time between checks while the Service runs, such as 1m (default ${HEALTHCHECK_DEFAULTS.interval}, at least ${MIN_HEALTHCHECK_INTERVAL_SECONDS}s).`,
      ),
    timeout: duration
      .optional()
      .describe(
        `How long one check may take before it counts as failed, such as 5s (default ${HEALTHCHECK_DEFAULTS.timeout}).`,
      ),
    retries: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        `Failed checks in a row before the Service is unhealthy (default ${HEALTHCHECK_DEFAULTS.retries}). One passing check makes it healthy again.`,
      ),
    start_period: duration
      .optional()
      .describe(
        `How long a start may take to pass its first check, such as 2m (default ${HEALTHCHECK_DEFAULTS.start_period}; Compose's is 0s). Until then Rig checks every 100 ms, not at interval, and a Service that depends on this one starts only once a check passed.`,
      ),
    disable: z
      .boolean()
      .optional()
      .describe(
        "true turns the healthcheck off, mainly in a Target patch to drop an inherited one; the Service then behaves as if it had none, start_period included.",
      ),
    on_failure: z
      .enum(["report", "restart"])
      .optional()
      .describe(
        "What Rig does once the Service is unhealthy (Rig's extension; Compose never restarts for health): report (default) shows it in status and records it in Activity; restart also stops it within its stop_timeout and starts it again, at once and then after 1m, 5m, 15m and every hour while it stays unhealthy.",
      ),
  })
  .describe(
    "Docker Compose's healthcheck. The first passing check is the start gate, and checks repeat at interval while the Service runs. Without a healthcheck, start waits for every declared port to accept a connection and nothing is checked afterwards.",
  );
const serviceFields = {
  command: command.describe(
    `Foreground shell command run with /bin/sh -c in working_dir (default: the workspace root); explicit bindings must be localhost only. ${SHELL_REFERENCES} ${referencesIn("service")}`,
  ),
  build: command
    .describe(
      `Shell build command of this Service, ${buildRule("in its working_dir (default: the workspace root)")} ${referencesIn("service")}`,
    )
    .optional(),
  build_timeout: buildTimeout.optional(),
  working_dir: workingDir.optional(),
  ports: ports.optional(),
  domain: serviceDomain.optional(),
  healthcheck: healthcheck.optional(),
  stop_timeout: stopTimeout.optional(),
  depends_on: z
    .array(entryName)
    .optional()
    .describe(
      "Services that must be running and have passed their start check (their healthcheck, or without one every declared port accepting a connection) before this one starts; a later dependency failure does not restart this Service.",
    ),
  restart: restart.optional(),
  environment: env("service").optional(),
  env_file: envFile("service").optional(),
  watch: watch.optional(),
};
const toolFields = {
  build: build.optional(),
  build_timeout: buildTimeout.optional(),
  bin: text.describe(
    `Executable path relative to the workspace; published in <RIG_ROOT>/bin under the Tool name for the stable Target, as <tool>-dev for the working Target and as <tool>-<preview name> for a Preview. An executable is copied there and runs from there, so it must be self-contained, like a compiled binary, or name the checkout it needs itself: dirname "$0" is <RIG_ROOT>/bin. A source file (.ts, .tsx, .js, .jsx, .mjs, .cjs) is not copied; it is published as a shim that runs it in place with the bun rigd install recorded, so its relative imports resolve. ${referencesIn("project")}`,
  ),
};
const tool = z.strictObject(toolFields);
/** The longest a job may run before Rig stops it: one week. */
const MAX_JOB_TIMEOUT_SECONDS = 7 * 86400;
/** The most backups `backup.keep` may keep per Target and job. */
const MAX_BACKUPS_KEPT = 1000;
/** The Targets a job runs in when it names none. */
export const DEFAULT_JOB_TARGETS: readonly (
  "working" | "stable" | "preview"
)[] = ["stable"];
const jobFields = {
  command: command.describe(
    `Shell command run with /bin/sh -c in working_dir (default: the workspace root) at each scheduled time, and by rig run. It runs from the same checkout as the Target's Services: the working copy for the working Target, the deployed Commit for the stable Target and Previews; a run a deploy finds going finishes on the checkout it started in, and the next run uses the new one. It has the Target's references, as a Service does: \${services.<service>.port} reaches a Service of the same Target, \${services.<service>.data} shares a Service's persistent directory, and \${rig.data} is the job's own. In a backup job (see backup), $RIG_BACKUP_DIR is the fresh directory this run writes its backup into. Its output goes to the Target logs under the job's name (rig logs --service <job>). Explicit bindings must be localhost only. ${SHELL_REFERENCES} ${referencesIn("job")}`,
  ),
  schedule: text
    .superRefine((value, ctx) => {
      const parsed = parseCron(value);
      if ("problem" in parsed)
        ctx.addIssue({ code: "custom", message: parsed.problem });
    })
    .describe(
      "When the job runs: a standard five-field cron expression, minute hour day-of-month month day-of-week, such as 17 */6 * * * (17 minutes past every sixth hour) or 0 7 * * 3,6 (07:00 on Wednesdays and Saturdays). Fields take *, numbers, ranges such as 1-5, lists such as 1,15, steps such as */6, and month or weekday names such as jan or mon; when both day fields name days, either matching runs it, as in cron. Times are wall-clock times in timezone. A run still going at the next scheduled time makes Rig skip that time and record it as skipped; times missed while the Mac slept or rigd was not running are not caught up.",
    ),
  timezone: text
    .refine(
      isTimeZone,
      "must be an IANA time zone name such as America/Chicago, Europe/Berlin or UTC",
    )
    .optional()
    .describe(
      "IANA time zone the schedule is read in, such as America/Chicago or UTC. Default: the Mac's own time zone (System Settings > General > Date & Time) as rigd reads it; after changing the Mac's zone, check the next run in rig status, and restart rigd (rigd install) if it still shows the old zone. Daylight saving time: a time the spring change skips (02:30 when clocks jump from 02:00 to 03:00) runs once at the change, 03:00; a time the autumn change repeats (01:30 when clocks fall back) runs once, the first time. Use UTC for a schedule that never shifts.",
    ),
  timeout: text
    .refine((value) => {
      const seconds = durationSeconds(value);
      return seconds >= 1 && seconds <= MAX_JOB_TIMEOUT_SECONDS;
    }, "must be a duration from 1s to 168h, such as 30m or 2h")
    .optional()
    .describe(
      "How long one run may take, such as 2h (at most 168h). A run still going then is stopped (SIGTERM, then SIGKILL after stop_timeout) and recorded as timed out. Default: no limit.",
    ),
  stop_timeout: stopTimeout
    .optional()
    .describe(
      "How long a run may take to exit after its stop signal (SIGTERM) before Rig ends it with SIGKILL, such as 1m (default 10s, at most 1h): when its timeout passes, and when rig down, a Preview destroy, or turning the Target off stops it. A deploy or rig restart lets a run finish.",
    ),
  working_dir: workingDir
    .optional()
    .describe(
      "Directory the job's command runs in, relative to the workspace, such as apps/jobs (default: the workspace root). It cannot leave the workspace: absolute paths, ~, '..' and references are refused. Relative env_file paths and ${rig.workspace} still mean the workspace root.",
    ),
  environment: env("job").optional(),
  env_file: envFile("job").optional(),
  targets: z
    .array(z.enum(["working", "stable", "preview"]))
    .min(1)
    .refine(
      (roles) => new Set(roles).size === roles.length,
      "must not name a Target twice",
    )
    .optional()
    .describe(
      "Which Targets run the job on its schedule, by their fixed names working, stable and preview (preview means every Preview). Default: [stable] only, so the schedule runs it once, against the Production branch, and not again in the working copy and every Preview. targets decides scheduling only: rig run <job> <target> runs it now in any Target that is on and deployed, such as working to try it. A Target runs its jobs on schedule only while it is on in rig.yaml, deployed and meant to run (rig down stops its schedule and any run in progress).",
    ),
  backup: z
    .strictObject({
      keep: z
        .number()
        .int()
        .min(1)
        .max(MAX_BACKUPS_KEPT)
        .describe(
          `How many successful backups of this job Rig keeps per Target, 1 to ${MAX_BACKUPS_KEPT}, such as 14. After each successful run only the newest keep stay, the one that just finished always among them; a failed run deletes nothing but its own directory.`,
        ),
      restore: command
        .optional()
        .describe(
          `Shell command rig backup restore <job> <backup> runs once to put a backup back, such as pg_restore --clean --if-exists -d app "$RIG_BACKUP_DIR/app.dump". It runs as a run of this job: the same Target checkout, working_dir, environment, env_file and references as command, never beside a run of the job, and with $RIG_BACKUP_DIR set to the chosen backup. Rig does not stop the Target's Services around it, so the command must replace what it restores itself (pg_restore --clean, say). Default: none, and restore is refused. ${SHELL_REFERENCES} ${referencesIn("job")}`,
        ),
    })
    .optional()
    .describe(
      'Makes this job a backup job (a scheduled job with retention): every run, scheduled or rig run, gets a fresh, empty directory <RIG_ROOT>/backups/<project>/<target>/<job>/<UTC time>-<number>/ (mode 0700; the number only grows, so a name is never issued twice) as $RIG_BACKUP_DIR, and command writes the backup into it, such as pg_dump -Fc -f "$RIG_BACKUP_DIR/app.dump". A run that fails, times out or is stopped has its directory deleted; a successful one is kept and shown by rig backup list, rig status and the dashboard. Rig never needs to know what it backs up. Backups stay on this Mac, outside the Target\'s data and checkout, so deploys and rig down/up keep them; destroying a Preview deletes its backups.',
    ),
};
const job = z.strictObject(jobFields);
/** A proxy upstream: a Service name, `${services.<name>.port}`, or `${services.<name>.ports.<port>}`. */
export const PROXY_UPSTREAM =
  /^(?:([a-z0-9][a-z0-9-]*)|\$\{services\.([a-z0-9][a-z0-9-]*)\.(?:port|ports\.([a-z0-9][a-z0-9-]*))\})$/;
const proxy = keyedMap(
  z
    .string()
    .regex(
      /^\/[A-Za-z0-9._~/-]*$/,
      "must be a path prefix starting with '/' without wildcards or references",
    ),
  z
    .string()
    .regex(
      PROXY_UPSTREAM,
      "must name a Service, such as web, or one of its ports, such as ${services.web.ports.http}",
    )
    .describe(
      "Upstream of this prefix: a Service name such as web, which means its only port, or exactly one port reference such as ${services.web.ports.http} or ${services.web.port}. No other reference or text is allowed.",
    ),
  "a path prefix",
).describe(
  "Path prefix to the Service, or the Service port, that serves it. Prefixes match at a slash boundary, longest first, and the upstream path is unchanged; '/' is required. Without proxy, a Target with a hostname routes '/' to the one Service that declares ports when that Service declares exactly one.",
);
/** A build in a Target patch: a command, or false to turn the inherited build off for that role. */
const BUILD_OFF =
  "false turns the inherited build off for this role's Targets; leaving the key out keeps it.";
/** What a patch build may be, for the value that is neither. */
export const PATCH_BUILD_SHAPES =
  "must be a command, or false to turn the inherited build off";
const patchBuild = <T extends z.ZodType>(command: T) =>
  z
    .union([command, z.literal(false)], { error: PATCH_BUILD_SHAPES })
    .optional()
    .describe(`${command.description ?? ""} In a Target patch, ${BUILD_OFF}`);
/** Settings every role may patch. Maps merge per key; lists and scalars replace. */
const patchFields = {
  domain: domain
    .optional()
    .describe(
      `Hostname for this role's Targets, such as \${rig.target}.preview.app.test. ${DOMAIN_REFERENCE}`,
    ),
  build: patchBuild(build),
  build_timeout: buildTimeout.optional(),
  environment: env("project").optional(),
  env_file: envFile("project").optional(),
  proxy: proxy.optional(),
  services: keyedMap(
    entryName,
    z
      .strictObject(serviceFields)
      .partial()
      .extend({ build: patchBuild(serviceFields.build.unwrap()) }),
    "a Service name",
  )
    .optional()
    .describe(
      "Setting overrides keyed by an existing Service name; a patch cannot add or remove Services.",
    ),
  tools: keyedMap(
    entryName,
    z.strictObject(toolFields).partial(),
    "a Tool name",
  )
    .optional()
    .describe(
      "Setting overrides keyed by an existing Tool name; a patch cannot add or remove Tools.",
    ),
};
/** What a role switch may be, for the value that is none of them. */
export const ROLE_SWITCH_SHAPES = "must be true, false or a map of settings";
/** One role's switch: true or a settings patch turns it on; false, or leaving the key out, keeps it off. */
const roleSwitch = (description: string) =>
  z
    .union([z.boolean(), z.strictObject(patchFields)], {
      error: ROLE_SWITCH_SHAPES,
    })
    .optional()
    .describe(description);
const targets = z.strictObject({
  working: roleSwitch(
    "The working Target, which runs this checkout as it is: true or a settings patch turns it on; false or leaving it out keeps it off. Its Tools are published as <tool>-dev.",
  ),
  stable: roleSwitch(
    "The stable Target, which serves the Production branch: true or a settings patch turns it on; false or leaving it out keeps it off. Its Tools are published under their plain names.",
  ),
  preview: roleSwitch(
    "Previews of other Branches: true or a settings patch applied to every Preview turns them on; false or leaving it out keeps them off. Preview names come from their Branch.",
  ),
});
/** Every rig.yaml field, without the rules that span fields; `projectConfigSchema` in schema.ts adds those. */
export const projectFields = z.strictObject({
  name,
  description: z.string().optional().describe("Project description."),
  production_branch: text
    .optional()
    .describe(
      "Branch the stable Target deploys; defaults to the Host deploy.production_branch, then main.",
    ),
  domain: domain
    .optional()
    .describe(
      `Hostname of the stable Target. A Preview defaults to this domain with a dash and its name after the first label, so app.example.com gives app-<preview-name>.example.com; the working Target has no hostname unless its patch sets one. ${DOMAIN_REFERENCE}`,
    ),
  build: build
    .optional()
    .describe(
      `Shared shell build command, run once in the workspace before any Service or Tool build. ${PROJECT_BUILD_REFERENCES}`,
    ),
  build_timeout: buildTimeout
    .optional()
    .describe(
      "Duration budget for the shared build and the default for Service and Tool builds (default 10m).",
    ),
  environment: env("project").optional(),
  env_file: envFile("project").optional(),
  services: keyedMap(entryName, z.strictObject(serviceFields), "a Service name")
    .optional()
    .describe("Long-running Services keyed by name."),
  tools: keyedMap(entryName, tool, "a Tool name")
    .optional()
    .describe("Installed command-line Tools keyed by name."),
  jobs: keyedMap(entryName, job, "a job name")
    .optional()
    .describe(
      "Scheduled jobs keyed by name: commands rigd runs at cron times, such as a nightly import, with the same command, environment, env_file and working_dir keys and references as a Service. By default a job runs in the stable Target only. A run never overlaps the one before it, appears in rig activity, writes to rig logs under the job's name, and rig status shows its last and next run; rig run <job> runs it now. A job with backup: is a backup job: each run writes a fresh $RIG_BACKUP_DIR, the newest backup.keep are kept, and rig backup list and rig backup restore read them. A job cannot share its name with a Service or Tool.",
    ),
  proxy: proxy.optional(),
  targets: targets
    .optional()
    .describe(
      "Which Targets are on, keyed by their fixed names working, stable and preview, each true, false or a settings patch. Only the Targets it turns on are on; without this key every Target is off.",
    ),
});
export type ProjectConfig = z.infer<typeof projectFields>;

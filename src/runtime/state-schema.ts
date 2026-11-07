import { isAbsolute } from "node:path";
import { z } from "zod";
import { MAX_STOP_TIMEOUT_SECONDS } from "../domain/stop-budget";
import { OPERATION_OUTCOMES } from "../domain/activity";
const text = z.string().min(1);
/** Registered paths are stored absolute, so comparing two of them never depends on rigd's working directory. */
const absolutePath = text.refine(isAbsolute, {
  message: "must be an absolute path",
});
const envFiles = z
  .array(
    z.object({
      path: absolutePath.describe("The env file's absolute path."),
      required: z
        .boolean()
        .describe(
          "true for a file rig.yaml lists in env_file, which must exist; false for an operator convention file under <RIG_ROOT>/env, read when present.",
        ),
    }),
  )
  .optional()
  .describe(
    "The env files an invocation loads, lowest to highest precedence; every file beats env. Only their paths are recorded, never their contents.",
  );
const commandInputs = z
  .array(
    z.object({
      name: text.describe("The environment name, such as DATABASE_URL."),
      source: text.describe(
        "The config path that declares it, such as services.api.environment.DATABASE_URL.",
      ),
      value: z.string().describe("Its public value, references resolved."),
    }),
  )
  .optional()
  .describe(
    "The public environment values the commands were built from; an env file may not change them. Absent when they were built from none.",
  );
const common = {
  name: text.describe("The Component's name in rig.yaml."),
  env: z
    .record(z.string(), z.string())
    .describe(
      "Public environment values only, references resolved: the Project's environment, then a Service's own.",
    ),
  envFiles,
  commandInputs,
  dependsOn: z
    .array(text)
    .describe(
      "The Services it depends on (depends_on), which start before it; always empty for a Tool.",
    ),
};
const component = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("managed").describe("A Service, which rigd runs."),
    command: text.describe(
      "The /bin/sh command that runs the Service, references resolved.",
    ),
    workingDir: text
      .optional()
      .describe(
        "Directory the Service's command, build and healthcheck command run in, relative to the plan's workspace; absent means the workspace root.",
      ),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe(
        "The Service's first declared port, the one status reports; absent when it declares none.",
      ),
    ports: z
      .record(text, z.number().int().min(1).max(65535))
      .optional()
      .describe(
        "Every declared port by its name under ports; a plan recorded before named ports carries only port.",
      ),
    sitePort: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe(
        "A second port plans of older Rig versions recorded for the Service; it is still checked for a listener and kept from other Targets. Plans Rig makes now never set it.",
      ),
    health: text
      .optional()
      .describe(
        "What one check runs, references resolved: a local http(s) URL or a /bin/sh command; absent when the Service is checked by connecting to its declared ports.",
      ),
    readyTimeout: z
      .number()
      .positive()
      .describe(
        "Seconds a start may take to pass its first check: the healthcheck's start_period, else 30.",
      ),
    healthcheck: z
      .object({
        interval: z
          .number()
          .int()
          .positive()
          .describe("Seconds between checks while the Service runs."),
        timeout: z
          .number()
          .int()
          .positive()
          .describe("Seconds one check may take before it counts as failed."),
        retries: z
          .number()
          .int()
          .positive()
          .describe("Failed checks in a row before the Service is unhealthy."),
        onFailure: z
          .enum(["report", "restart"])
          .describe(
            "Whether Rig only reports an unhealthy Service or also restarts it.",
          ),
      })
      .optional()
      .describe(
        "The Service's healthcheck in force, whose checks repeat while it runs; absent when it has none, as in every plan recorded before healthcheck, whose `health` only gates start.",
      ),
    stopTimeout: z
      .number()
      .int()
      .min(1)
      .max(MAX_STOP_TIMEOUT_SECONDS)
      .optional()
      .describe(
        "Seconds the Service may take to exit after SIGTERM before SIGKILL; absent in plans recorded before stop_timeout, which get 10.",
      ),
    restart: z
      .enum(["always", "on-failure", "no"])
      .optional()
      .describe(
        "When Rig starts the Service again after a known exit; absent means always.",
      ),
    watch: z
      .array(text)
      .optional()
      .describe(
        "Pathspecs, relative to the workspace root, of the checkout files whose change makes a deploy restart the Service; an empty list means none. Absent means the whole checkout.",
      ),
  }),
  z.object({
    ...common,
    kind: z.literal("installed").describe("A Tool, which Rig publishes."),
    entrypoint: text.describe(
      "The absolute path of the Tool's executable: its bin, resolved against the workspace.",
    ),
    installName: text
      .optional()
      .describe(
        "The name a plan of an older Rig version published the Tool under in place of its own; plans Rig makes now never set it.",
      ),
    publishedAs: text
      .optional()
      .describe(
        "The file name under <RIG_ROOT>/bin the Tool was published as when it does not follow the Target's name: a working Target recorded under another name before Target names were fixed. Planning the Target again retires it.",
      ),
  }),
  z.object({
    ...common,
    kind: z
      .literal("persistent")
      .describe(
        "Storage that plans of older Rig versions recorded as a Component; Rig plans none now.",
      ),
    uses: z.literal("sqlite").describe("The storage kind: a SQLite database."),
    path: text.describe("The database file."),
  }),
]);
const planJob = z.object({
  name: text.describe("The job's name under jobs in rig.yaml."),
  command: text.describe("/bin/sh command the job runs, references resolved."),
  workingDir: text
    .optional()
    .describe(
      "Directory the job runs in, relative to the plan's workspace; absent means the workspace root.",
    ),
  env: z
    .record(z.string(), z.string())
    .describe(
      "Public environment values only, references resolved: the Project's environment, then the job's own.",
    ),
  envFiles,
  commandInputs,
  schedule: text.describe("Five-field cron expression, read in timeZone."),
  scheduled: z
    .literal(false)
    .optional()
    .describe(
      "false when the job's targets do not name this Target's role: only rig run runs it here. Absent: the schedule runs it.",
    ),
  timeZone: text
    .optional()
    .describe(
      "IANA time zone of the schedule; absent means the Host's zone when each run is scheduled.",
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Seconds one run may take before it is stopped as timed out; absent means no limit.",
    ),
  stopTimeout: z
    .number()
    .int()
    .min(1)
    .max(MAX_STOP_TIMEOUT_SECONDS)
    .optional()
    .describe(
      "Seconds a run may take to exit after SIGTERM before SIGKILL; absent means 10.",
    ),
  backup: z
    .object({
      keep: z
        .number()
        .int()
        .positive()
        .describe("How many successful backups are kept."),
      restore: text
        .optional()
        .describe(
          "/bin/sh command rig backup restore runs, references resolved; absent: restore is refused.",
        ),
    })
    .optional()
    .describe(
      "Present for a backup job: each run writes a fresh $RIG_BACKUP_DIR (ADR 0017).",
    ),
});
export const targetPlanSchema = z.object({
  project: text.describe(
    "The Project's name in rig.yaml when the plan was made.",
  ),
  target: z
    .enum(["working", "stable", "preview"])
    .describe("The role of the Target the plan is for."),
  workspacePath: text.describe(
    "The checkout the Target runs from: the Working copy for the working Target, a checkout of its Commit under the Rig root for the stable Target and a Preview.",
  ),
  dataRoot: text.describe(
    "The Target's Persistent storage directory; each Service's ${services.<name>.data} is a directory in it.",
  ),
  deploymentName: text.describe(
    "The Target's name, which ${rig.target} resolves to: working, stable or the Preview's name.",
  ),
  branchSlug: text.describe(
    "The same as deploymentName in every plan Rig makes now; kept for older Rig versions, which read it.",
  ),
  subdomain: z
    .string()
    .describe(
      "The same as deploymentName in every plan Rig makes now; kept for older Rig versions, which read it.",
    ),
  branch: text
    .optional()
    .describe(
      "The Branch the checkout was materialized from; absent for the working Target.",
    ),
  commit: text
    .optional()
    .describe(
      "The Commit the checkout was materialized from; absent for the working Target.",
    ),
  providers: z
    .object({
      processSupervisor: text.describe(
        "What supervises the Target's processes: rigd in every plan Rig makes now. A plan recorded with launchd is read as rigd's.",
      ),
    })
    .describe("The providers the plan runs with."),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "The Project's public environment values, references resolved, for Project-scope commands such as the shared build; absent on plans recorded before it.",
    ),
  daemon: z
    .object({
      enabled: z
        .boolean()
        .optional()
        .describe("A setting of older Rig versions; nothing reads it now."),
      keepAlive: z
        .boolean()
        .optional()
        .describe("A setting of older Rig versions; nothing reads it now."),
    })
    .optional()
    .describe(
      "Settings plans of older Rig versions recorded; plans Rig makes now never set it.",
    ),
  components: z
    .array(component)
    .describe("The Target's Services and Tools, in dependency order."),
  jobs: z
    .array(planJob)
    .optional()
    .describe(
      "The scheduled jobs this Target runs; absent when it runs none, as in every plan recorded before jobs.",
    ),
  builds: z
    .array(
      z.object({
        id: text.describe(
          "shared, service:<name> or tool:<name>: the identity the unit's outcome is recorded under.",
        ),
        component: text
          .optional()
          .describe(
            "The Service or Tool whose environment the command runs in; absent for the shared Project build.",
          ),
        command: text.describe(
          "The /bin/sh build command, references resolved.",
        ),
        timeout: z
          .number()
          .positive()
          .describe(
            "Seconds before the build is killed and recorded as failed.",
          ),
        commandInputs,
      }),
    )
    .optional()
    .describe(
      "Build units in run order: the shared build, then each Service's in dependency order, then each Tool's by name. Absent when there are none, and on plans recorded before builds were units.",
    ),
  preparedComponents: z
    .array(
      z.discriminatedUnion("uses", [
        z.object({
          name: text.describe("The Component's name."),
          uses: z.literal("sqlite").describe("A SQLite database file."),
          path: text.describe("The database file, created empty when missing."),
        }),
        z.object({
          name: text.describe("The Component's name."),
          uses: z.literal("convex").describe("A Convex state directory."),
          stateDir: text.describe(
            "The state directory, linked into the workspace.",
          ),
        }),
        z.object({
          name: text.describe("The Component's name."),
          uses: z.literal("postgres").describe("A Postgres data directory."),
          dataDir: text.describe("The data directory."),
        }),
      ]),
    )
    .describe(
      "Storage plans of older Rig versions prepared before the first start; always empty in plans Rig makes now.",
    ),
  domain: text
    .optional()
    .describe(
      "The Project domain resolved for this Target's role, ${rig.target} filled in; absent when the role has none, or no Service is behind /. Service domains are separate, in serviceDomains.",
    ),
  proxy: z
    .object({
      upstream: text.describe("The Service behind /."),
      routes: z
        .array(
          z.object({
            prefix: text.describe(
              "The path prefix, matched at a slash boundary; the Service sees the path unchanged.",
            ),
            service: text.describe("The Service it reaches."),
            port: z
              .number()
              .int()
              .min(1)
              .max(65535)
              .describe("The Service's port it reaches."),
          }),
        )
        .optional()
        .describe(
          "The hostname's whole route map, longest prefix first; a plan recorded before route maps has only upstream.",
        ),
    })
    .optional()
    .describe(
      "The routes of domain, which the plan sets together with domain.",
    ),
  serviceDomains: z
    .array(
      z.object({
        hostname: text.describe("The Service domain, ${rig.target} resolved."),
        service: text.describe("The Service every path of it reaches."),
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .describe("The Service's port it reaches."),
      }),
    )
    .optional()
    .describe(
      "The Target's Service domains, in Service order; published with domain as one route, and withdrawn with it. Absent when it serves none, as on every plan recorded before them.",
    ),
  installTimeout: z
    .number()
    .positive()
    .optional()
    .describe("Seconds dependency installation may take; absent means 600."),
  envFiles,
  referenceValues: z
    .record(z.string().regex(/^_RIG_[A-Za-z0-9_]+$/), z.string())
    .optional()
    .describe(
      "The values the plan's shell commands read through _RIG_ variables, by variable name; absent on plans recorded before them, whose commands hold their values.",
    ),
});
const writtenEnvironment = text
  .optional()
  .describe(
    "Keyed digest of the same environment without its _RIG_ variables, as a plan with its values written into its commands gives it, so a Service started from a plan recorded before reference variables can still be kept; absent when it has none. Never a value.",
  );
const preparation = z
  .object({
    deployment: text.describe(
      "The workspace the outcomes belong to; outcomes never carry over to another workspace.",
    ),
    environment: text
      .optional()
      .describe(
        "Keyed digest of the Project-scope environment the workspace's dependency installation ran in, as it was when the preparation began; never a value.",
      ),
    writtenEnvironment,
    units: z
      .record(
        text,
        z.object({
          state: z
            .enum(["started", "succeeded", "failed"])
            .describe(
              "started outside a running operation means the outcome is unknown.",
            ),
          policy: text.describe(
            "Digest of the unit's public policy; never env-file values.",
          ),
          commit: text
            .optional()
            .describe(
              "The Commit the workspace was materialized from; absent for the working Target.",
            ),
          environment: text
            .optional()
            .describe(
              "Keyed digest of the environment the unit's command ran in, as it was then; never a value.",
            ),
          writtenEnvironment,
          startedAt: text.describe(
            "When the unit's command started (ISO 8601).",
          ),
          finishedAt: text
            .optional()
            .describe("When it ended (ISO 8601); absent while started."),
        }),
      )
      .describe(
        "Each build unit's latest outcome in the workspace, by unit id.",
      ),
  })
  .optional()
  .describe(
    "What preparing the plan's workspace recorded: its dependency installation and each build unit's outcome. Absent before the first preparation.",
  );
const at = text.describe("When Rig recorded the outcome.");
const hostRestart = z
  .enum(["reboot", "login"])
  .describe(
    "A Host restart rigd detected at its start: the Mac restarted (reboot), or the user logged out and in again (login).",
  );
const services = z
  .record(
    text,
    z.object({
      deployment: text.describe(
        "The Deployment (its workspace) the run belongs to: the one that started the process, or the one that adopted it when a deploy kept it running. A record of another Deployment describes nothing.",
      ),
      source: z
        .object({
          checkout: absolutePath.describe(
            "The checkout the process runs in: its plan's workspace when it was started. While the process runs, Rig keeps this checkout on disk.",
          ),
          commit: text
            .optional()
            .describe(
              "The Commit that checkout was materialized from; absent for the working Target.",
            ),
          definition: text.describe(
            "Digest of the Service's definition when it was started, the checkout path replaced by a placeholder.",
          ),
          environment: text
            .optional()
            .describe(
              "Keyed digest (HMAC-SHA256, key under <RIG_ROOT>/auth) of the environment the process was started with, env files included, the checkout path normalized; never a value. Absent when it could not be computed, and the run is then never kept.",
            ),
          build: text
            .optional()
            .describe(
              "Digest of the environments its checkout was prepared in, as recorded then: the dependency installation's, the shared build's and the Service's own build's. A deployed Target's starts reuse its Deployment's builds, so they carry the same value; an explicit start or restart of the working Target builds again, so it may change. Absent when they were not all recorded, and the run is then never kept.",
            ),
        })
        .optional()
        .describe(
          "Where and from what the process was started, which a deploy compares to keep an unchanged Service running; absent on a run started before Rig recorded it, which a deploy never keeps.",
        ),
      intent: z
        .enum(["running", "stopped"])
        .describe(
          "stopped once an operator stopped the Target; no exit is retried under it.",
        ),
      incarnation: text
        .optional()
        .describe(
          "The latest process Rig started; exit evidence naming another one is ignored.",
        ),
      attempts: z
        .array(z.number().finite())
        .describe(
          "Unix milliseconds of the automatic attempts since the last explicit start.",
        ),
      outcome: z
        .discriminatedUnion("kind", [
          z.object({
            kind: z
              .literal("exited")
              .describe(
                "The process ended, with the exit its own record or the wrapper's gives.",
              ),
            exitCode: z
              .number()
              .int()
              .optional()
              .describe("The exit code, when the process exited."),
            signal: text
              .optional()
              .describe("The signal that ended it, when one did."),
            recordedBy: z
              .enum(["launchd", "rigd"])
              .optional()
              .describe(
                "Who saw the end when the application's own exit record was missing: rigd's record of the wrapper it spawned, or launchd's record of its capture wrapper's job (recorded by Rig versions that offered launchd supervision).",
              ),
            at,
          }),
          z.object({
            kind: z
              .enum(["activation-failed", "start-failed"])
              .describe(
                "A start could not be verified and its process was stopped: activation-failed for an automatic attempt, which counts as a failure to retry; start-failed for an operator's own start, which is theirs to repeat.",
              ),
            errorCode: text.describe("The error code the start failed with."),
            at,
          }),
          z.object({
            kind: z
              .literal("unknown")
              .describe(
                "The process is gone and nothing recorded how; never treated as a clean exit, a failure or a requested stop.",
              ),
            hostRestart: hostRestart
              .optional()
              .describe(
                "The process is gone because of this Host restart; a working or Preview Service is not started again before rig up.",
              ),
            at,
          }),
        ])
        .optional()
        .describe(
          "How the latest process ended; unknown means it is gone and nothing recorded how.",
        ),
      unknownAttempts: z
        .array(z.number().finite())
        .optional()
        .describe(
          "Unix milliseconds of the automatic attempts made after an unknown exit since the last explicit start; a separate, slower budget.",
        ),
      retryAt: z
        .number()
        .finite()
        .optional()
        .describe(
          "Unix milliseconds before which the next automatic attempt must not start.",
        ),
      waitingFor: z
        .union([
          z.object({
            service: text.describe(
              "The Service it depends on that is not running.",
            ),
          }),
          z.object({
            ports: z
              .array(z.number().int())
              .describe("Its ports that still accept connections."),
          }),
        ])
        .optional()
        .describe(
          "Why a due automatic attempt is held back without spending budget.",
        ),
      restartedAfterUnknown: z
        .literal(true)
        .optional()
        .describe(
          "The running process was started automatically after an unknown exit.",
        ),
      startedAfterHostRestart: hostRestart
        .optional()
        .describe(
          "The running process was started by rigd after it detected this Host restart.",
        ),
      exhausted: z
        .literal(true)
        .optional()
        .describe(
          "The automatic attempts are used up until an explicit start or a new Deployment.",
        ),
      stopKilled: z
        .enum(["timeout", "request"])
        .optional()
        .describe(
          "The operator's latest stop needed SIGKILL: the Service's stop_timeout ran out, or --kill cut it short.",
        ),
      startSeq: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Where this start falls in the order of starts and Host restarts (the state's startSeq). A stop by a Host restart is recorded only for a run started before the restart was recorded; a run without this field was started by an older rigd and counts as before.",
        ),
      healthStretch: z
        .object({
          since: z
            .number()
            .finite()
            .describe("Unix milliseconds when the Service became unhealthy."),
          restarts: z
            .array(z.number().finite())
            .describe(
              "Unix milliseconds of each health restart in this stretch.",
            ),
          pendingStart: z
            .number()
            .finite()
            .optional()
            .describe(
              "Unix milliseconds when the latest health restart began, written before it stopped anything and cleared once its start passed. Until then the health monitor owns the Service: it checks it while a process runs, and starts it at the next step of the back-off while none does, whatever its restart policy.",
            ),
        })
        .optional()
        .describe(
          "The unhealthy stretch a health restart started the running process in, so a new rigd continues its back-off; an explicit start clears it.",
        ),
    }),
  )
  .optional()
  .describe("Intent and known process outcomes per managed Service name.");
// `formerNames` and `renaming` joined without a STATE_VERSION bump: an older rigd keeps them as they are and only ignores
// them, so it refuses a deployed Commit that names a former name, as it always did.
const project = z.object({
  id: text.describe(
    "The Project's stable id, kept across rename and repoint; its Targets and storage are filed under it.",
  ),
  name: text.describe(
    "The Project's registered name, as rig.yaml declares it.",
  ),
  repoPath: absolutePath.describe(
    "The repository directory it is registered at.",
  ),
  configPath: absolutePath.describe("Its rig.yaml."),
  createdAt: text.describe("When it was registered (ISO 8601)."),
  formerNames: z
    .array(text)
    .optional()
    .describe(
      "The names rig rename replaced, oldest first: a deployed Commit whose rig.yaml names one is still this Project's.",
    ),
  renaming: z
    .object({
      to: text.describe("The name the rename gives the Project."),
      env: z
        .enum(["none", "move", "copy"])
        .describe(
          "How it carries the operator env directory: nothing to carry, renamed, or copied because a Project whose name differs only in case shares it.",
        ),
      config: text.describe(
        "The name rig.yaml had before the rename, which undoing it puts back.",
      ),
    })
    .optional()
    .describe(
      "A rig rename that began and did not finish or undo: its rig.yaml or env files may have the new name already, which no other Project may take until rig rename finishes or undoes it.",
    ),
});
const target = z.object({
  id: text.describe(
    "The Target's stable id, which a Preview made again under the same name does not share.",
  ),
  projectId: text.describe("The id of the Project it belongs to."),
  name: text.describe("Its name: working, stable or the Preview's name."),
  kind: z.enum(["working", "stable", "preview"]).describe("Its role."),
  branch: text
    .optional()
    .describe(
      "The Branch it was deployed from; absent for the working Target.",
    ),
  commit: text
    .optional()
    .describe("The Commit it was deployed at; absent for the working Target."),
  plan: targetPlanSchema.describe(
    "The runtime plan it runs: for a deployed Target the one its deploy recorded, for the working Target the one made from rig.yaml when it last started from stopped or restarted.",
  ),
  desired: z
    .enum(["running", "stopped"])
    .describe(
      "Whether the Target is meant to run: running after up, restart or a deploy that starts it, stopped after down or a --no-up deploy.",
    ),
  createdAt: text.describe("When the Target was first recorded (ISO 8601)."),
  updatedAt: text.describe(
    "When an Operation last changed its record (ISO 8601).",
  ),
  logRoot: text.describe(
    "The directory its logs are written in, under the Rig root; it stays when the Project is renamed.",
  ),
  sourceRoot: text
    .optional()
    .describe(
      "The directory a deployed Target's checkouts are materialized in, under the Rig root; absent for the working Target.",
    ),
  destructionPending: z
    .literal(true)
    .optional()
    .describe(
      "Preview deletion is pending; retain inventory and retry explicit destroy without restarting.",
    ),
  deploymentIncomplete: z
    .literal(true)
    .optional()
    .describe("Deployment has not committed; matching source must be retried."),
  preparation,
  services,
  uncertainBuild: z
    .object({
      branch: text.optional().describe("Branch of the attempted source."),
      commit: text.optional().describe("Commit of the attempted source."),
      unit: text.describe("The build unit whose outcome is unknown."),
    })
    .optional()
    .describe(
      "A rolled-back deployment attempt whose build outcome is unknown; that source deploys again only with force.",
    ),
  configRevision: text
    .optional()
    .describe(
      "Revision of the rig.yaml a working Target's plan was made from, for reporting drift.",
    ),
  configDigest: text
    .optional()
    .describe(
      "Digest of what that rig.yaml said, whatever its comments or layout; drift is reported when the file and it both change.",
    ),
  recovery: z
    .object({
      plan: targetPlanSchema.describe(
        "The previous Deployment's plan, which a rollback restores; a first deployment's own.",
      ),
      preparation,
      branch: text.optional().describe("The previous Deployment's Branch."),
      commit: text.optional().describe("The previous Deployment's Commit."),
      desired: z
        .enum(["running", "stopped"])
        .describe("Whether the Target was meant to run before the deploy."),
      deploymentIncomplete: z
        .literal(true)
        .optional()
        .describe("The rollback plan has not completed a deployment."),
      stage: z
        .enum(["pending", "blocked", "committing"])
        .describe(
          "pending while the deploy runs, or after it was interrupted; blocked when a failed deploy's rollback could not be verified; committing once the deploy decided to keep its new Deployment. rig down settles each: it rolls a pending or blocked deploy back to plan, and completes a committing one.",
        ),
      // Optional, so no STATE_VERSION bump (see there): an older rigd keeps it as it is, and its rig down settles without it.
      served: z
        .object({
          from: text
            .optional()
            .describe(
              "When the router confirmed the first path to a Service the candidate's start started (ISO 8601).",
            ),
          until: text
            .optional()
            .describe(
              "When a confirmed route change removed the last such path (ISO 8601); the first stands.",
            ),
        })
        .optional()
        .describe(
          "What the candidate served: written before a publication gives it a path, so rig down after a crash can say that it may have served, and from when until when.",
        ),
    })
    .optional()
    .describe(
      "A deploy that has not finished, or that failed or was interrupted before it settled: what it would roll back to. While it is present, only rig down, or a Preview's destroy, settles the Target.",
    ),
});
const jobRun = z.object({
  id: text.describe(
    "The run's identity: its process's incarnation, and the id of its Activity entries.",
  ),
  trigger: z
    .enum(["schedule", "manual", "restore"])
    .describe(
      "What started it: the schedule, rig run, or rig backup restore (a run of the job's restore command).",
    ),
  scheduledFor: text
    .optional()
    .describe("The scheduled time a scheduled run is for (ISO 8601)."),
  startedAt: text.describe("When the run started (ISO 8601)."),
  backup: z
    .object({
      id: text.describe("The backup's id, its run's start in UTC."),
      path: absolutePath.describe(
        "The fresh directory the run writes, under RIG_ROOT/backups.",
      ),
      keep: z
        .number()
        .int()
        .positive()
        .describe("How many backups the job kept when the run started."),
      sequence: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "The id's number in the job's backup sequence, kept with the backup to order it; absent for a run an older Rig started.",
        ),
      made: z
        .literal(true)
        .optional()
        .describe(
          "The run made the directory: recorded once it did, before its process started. Only a directory its run made is deleted when the run fails; one a run never made, or found already there, is left in place.",
        ),
      lost: z
        .literal(true)
        .optional()
        .describe(
          "The run exited 0 but left no directory there (it deleted or replaced it), so it kept no backup.",
        ),
    })
    .optional()
    .describe(
      "A backup job's run: the directory it writes ($RIG_BACKUP_DIR), recorded before it is made. Kept as a backup when the run succeeds, deleted otherwise if the run made it.",
    ),
  restore: z
    .object({
      id: text.describe("The backup's id."),
      path: absolutePath.describe("Its directory."),
    })
    .optional()
    .describe("A restore run: the backup it reads ($RIG_BACKUP_DIR)."),
  workspace: absolutePath
    .optional()
    .describe(
      "The checkout the run started in; a deploy keeps it on disk until the run ends.",
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Seconds the run may take before it is stopped as timed out, as its plan said when it started; absent means no limit.",
    ),
  stopTimeout: z
    .number()
    .int()
    .min(1)
    .max(MAX_STOP_TIMEOUT_SECONDS)
    .optional()
    .describe(
      "Seconds the run may take to exit after SIGTERM, as its plan said when it started.",
    ),
  finishedAt: text
    .optional()
    .describe("When the run ended (ISO 8601); absent while it runs."),
  outcome: z
    .enum([
      "succeeded",
      "failed",
      "timed-out",
      "stopped",
      "unknown",
      "start-failed",
    ])
    .optional()
    .describe(
      "How the run ended: exit 0, another exit or a signal, stopped at its timeout, stopped by Rig (rig down, a Preview destroy or its Target turned off; a deploy or restart never stops a run), gone with nothing recording how, or never started.",
    ),
  exitCode: z
    .number()
    .int()
    .optional()
    .describe("Its process's exit code, when it exited."),
  signal: text
    .optional()
    .describe("The signal that ended its process, when one did."),
  errorCode: text
    .optional()
    .describe("Why a start failed, as the error code Rig reported."),
  skipped: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Scheduled times skipped because this run was still going."),
  stopping: z
    .object({
      cause: z
        .enum(["stopped", "timed-out"])
        .describe(
          "Stopped by Rig (rig down, a destroy, an off switch), or at its timeout.",
        ),
      at: text.describe("When Rig decided to stop it (ISO 8601)."),
      endedAt: text
        .optional()
        .describe(
          "When the stop found its process gone (ISO 8601): the run's end, however much later it is recorded.",
        ),
    })
    .optional()
    .describe(
      "Rig's decision to stop the run, written before the stop signal, so its end is recorded with this cause even by a rigd that restarted in between.",
    ),
});
const jobRecord = z.object({
  target: text.describe("The Target's id."),
  job: text.describe("The job's name in that Target's plan."),
  running: jobRun
    .optional()
    .describe(
      "The run in progress, recorded before its process is started; rigd settles it once the process is gone.",
    ),
  last: jobRun.optional().describe("The latest run that ended."),
  lastScheduled: text
    .optional()
    .describe(
      "The latest scheduled time rigd acted on, run, skipped or passed over (ISO 8601); a new rigd never acts on it again, nor on an earlier one unless the clock was set back past it.",
    ),
  handled: z
    .array(text)
    .optional()
    .describe(
      "The scheduled times rigd acted on most recently, run, skipped or passed over (ISO 8601), oldest first and at most 60: none is acted on again, even after the clock was set back past it.",
    ),
  watchedFrom: text
    .optional()
    .describe(
      "When rigd first saw the job in the Target's plan (ISO 8601); a new rigd counts scheduled times from it, within the late limit, until one was acted on.",
    ),
});
const operation = z.object({
  id: text.describe(
    "The Operation's id, or a job run's id for the record of a run.",
  ),
  projectId: text
    .optional()
    .describe(
      "The id of the Project it is about; absent when it is about none.",
    ),
  project: text
    .optional()
    .describe("That Project's name when it was recorded."),
  target: text
    .optional()
    .describe("The Target's name; absent for a Project or Host record."),
  component: z
    .object({
      kind: z
        .enum(["service", "job"])
        .describe("Whether it is a Service or a job."),
      name: text.describe("Its name in rig.yaml."),
    })
    .optional()
    .describe(
      "The Service or Job the record is about, by its name in rig.yaml; absent for a whole Target or Project.",
    ),
  action: text.describe(
    "What the record is about: the command's action, such as deploy, or what rigd did itself, such as crash or job.",
  ),
  // `forgotten`, and `updated` (an operator env file changed from the dashboard), joined this list without a STATE_VERSION
  // bump (see there). A rigd from before either refuses the state as
  // STATE_CORRUPT once such an entry is recorded, until rigd is upgraded again or the entry is deleted by hand.
  outcome: z
    .enum(OPERATION_OUTCOMES)
    .describe("How the Operation ended, as rig activity shows it."),
  occurredAt: text.describe("When it ended (ISO 8601)."),
  message: z.string().optional().describe("What happened, or why it failed."),
});
/** The state file format this rigd writes. Bump it whenever a record gains or changes a field so that an older rigd
 * refuses the file instead of silently dropping what it does not know. Two kinds of change are not bumped.
 * A new optional top-level key needs no bump: an older rigd validates without it and writes it back unchanged.
 * A new value of an existing enum, such as an Activity outcome, needs none either: the file stays readable by an older
 * rigd until a record holds the new value, and that rigd then refuses it as STATE_CORRUPT rather than misread it.
 * An Activity record's `component` needed none: an older rigd keeps it as it is (the store returns the file as read),
 * and only ignores it, which changes nothing it does; a bump would make it refuse the whole state instead.
 * Version 6 added scheduled jobs to plans (`plan.jobs`): an older rigd would keep them but never run them. Version 7 added
 * backups (`backup` on a plan's job and on a run, ADR 0017): an older rigd would run a backup job without its directory.
 * Version 8 (ADR 0016) added where each Service's process runs (`source`), the Services a deploy kept, `watch`, and held
 * checkouts: an older rigd would drop them and release a checkout a kept process still runs in. Version 9 keeps health
 * output only with env-file values redacted: an older rigd would record a failed check's output as printed, and Activity
 * from before it is read with that output withheld (see state-store). Version 10 orders backups by `sequence` (on a run's
 * `backup` and on a backup): an older rigd would record backups without it, which a later rigd would then rank as older
 * than every backup it made. */
export const STATE_VERSION = 10;
/** The older state versions this rigd still reads. Version 4 named the working and stable Targets local and live, or what
 * rig.yaml renamed them to, and is normalized as it is read (see state-store). Version 5 is version 6 without jobs,
 * version 6 is version 7 without backups, version 7 is version 8 before ADR 0016, version 8 is version 9 with health
 * output unredacted, and version 9 is version 10 with no backup's `sequence`; they are read so. The next write saves
 * STATE_VERSION. */
export const MIGRATED_STATE_VERSIONS: readonly number[] = [4, 5, 6, 7, 8, 9];
/** The first version whose Activity holds health output only redacted. */
export const REDACTED_HEALTH_STATE_VERSION = 9;
/** The version whose Target names are normalized as they are read. */
export const UNFIXED_NAMES_STATE_VERSION = 4;
const deployment = z.object({
  id: text.describe("The deploy's Operation id, as Activity records it."),
  projectId: text.describe("The Project's identity."),
  project: text.describe("The Project's name when it deployed."),
  target: text.describe("The Target's name: stable or the Preview's name."),
  targetId: text
    .optional()
    .describe(
      "The Target's id, which a Preview made again under the same name does not share; absent on a deploy recorded before Rig kept it, and on one that failed before its Target existed.",
    ),
  kind: z.enum(["stable", "preview"]).describe("The Target's role."),
  branch: text.optional().describe("The Branch deployed."),
  commit: text
    .optional()
    .describe(
      "The Commit deployed, or the one asked for when the deploy failed after resolving it.",
    ),
  previousCommit: text
    .optional()
    .describe("The Commit the Target ran before, when it had one."),
  outcome: z
    .enum(["deployed", "unchanged", "failed"])
    .describe("How the deploy ended."),
  kept: z
    .array(text)
    .optional()
    .describe(
      "The Services a successful deploy kept running instead of restarting, because nothing they use changed; absent when it restarted every Service.",
    ),
  startedAt: text.describe("When rigd began the deploy (ISO 8601)."),
  finishedAt: text.describe("When it recorded the outcome (ISO 8601)."),
  // Optional, so no STATE_VERSION bump (see there): an older rigd keeps it as it is.
  servedAt: text
    .optional()
    .describe(
      "When the new Commit began to answer requests (ISO 8601). A failed deploy has one when it served before it was rolled back.",
    ),
  message: z
    .string()
    .optional()
    .describe("A failed deploy's error code; never an environment value."),
});
export const runtimeStateSchema = z
  .object({
    version: z
      .literal(STATE_VERSION)
      .describe(
        "The state file format. A file of an older version this rigd reads is migrated as it is read; any other is refused unread.",
      ),
    projects: z.array(project).describe("Every registered Project."),
    targets: z
      .array(target)
      .describe("Every recorded Target of every Project, running or stopped."),
    activity: z
      .array(operation)
      .describe(
        "The Activity log: final Operations and what rigd did on its own, oldest first, the newest 1000 kept.",
      ),
    // A new optional top-level key, so no STATE_VERSION bump (see there): an older rigd keeps it as it is.
    deployments: z
      .array(deployment)
      .optional()
      .describe(
        "Deploys rigd attempted, oldest first and bounded, with the Branch and Commit each deployed and how it ended; the dashboard's history and rollback read them.",
      ),
    jobs: z
      .array(jobRecord)
      .optional()
      .describe(
        "Scheduled job runs per Target and job: the run in progress and the latest one that ended. Only rigd's job runner writes them, so no Target write replaces them.",
      ),
    heldCheckouts: z
      .array(
        z.object({
          target: text.describe("The Target's id."),
          project: text.describe("The Project's id."),
          workspace: absolutePath.describe("The checkout to give back."),
        }),
      )
      .optional()
      .describe(
        "Superseded checkouts something may still run in: one a job run kept after a deploy, recorded with the run's end, one a Service a deploy kept running runs in, recorded by that deploy, or the checkout of the plan a recovery dropped, recorded in the same write. Each is offered back every 30 seconds and given back once no job run or Service process runs in it; a rigd that stops first finds them again. State version 6 called them jobCheckouts.",
      ),
    backups: z
      .array(
        z.object({
          target: text.describe("The Target's id."),
          project: text.describe("The Project's id."),
          job: text.describe("The backup job's name."),
          id: text.describe(
            "The backup's id: its run's start in UTC and its number in the job's backup sequence, such as 20261011T030000Z-17; never issued twice.",
          ),
          path: absolutePath.describe("Its directory under RIG_ROOT/backups."),
          run: text.describe("The run that wrote it."),
          trigger: z
            .enum(["schedule", "manual"])
            .describe("Whether the schedule or rig run started that run."),
          startedAt: text.describe("When its run started (ISO 8601)."),
          finishedAt: text.describe(
            "When its run ended (ISO 8601), for display: retention and latest order backups by sequence, never by time.",
          ),
          sequence: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Its number in the job's backup sequence (the number its id ends in), which follows the order the job's runs were recorded in: the newest backup has the highest. Absent on a backup an older Rig recorded; those are older than every backup that has one, and ordered among themselves by their place in this list.",
            ),
          bytes: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe("Its total size, once it was measured after its run."),
        }),
      )
      .optional()
      .describe(
        "Kept backups of backup jobs (ADR 0017): the successful runs' directories, the newest keep per Target and job.",
      ),
    backupSequences: z
      .array(
        z.object({
          project: text.describe("The Project's name."),
          target: text.describe("The Target's name."),
          job: text.describe("The backup job's name."),
          last: z
            .number()
            .int()
            .positive()
            .describe("The last backup number issued; the next gets one more."),
        }),
      )
      .optional()
      .describe(
        "The last backup number issued per backup directory (<project>/<target>/<job> by name, names that differ only in case sharing one, as they share one directory on a case-insensitive disk), so a backup id (UTC second and number) is never issued twice and its number orders the backups; never reset, even when the backups, the Preview or the Project's registration go.",
      ),
    backupRemovals: z
      .array(
        z.object({
          target: text.describe("The Target's id."),
          project: text.describe("The Project's id."),
          path: absolutePath.describe("The backup directory to delete."),
        }),
      )
      .optional()
      .describe(
        "Backup directories Rig decided to delete (a failed run's, or a backup past keep), recorded before they are deleted so a rigd that stops first deletes them.",
      ),
    startSeq: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "The last value handed out to order starts and Host restarts: each journalled start takes the next one, and a recorded Host restart notes the value it found. It only grows.",
      ),
    host: z
      .object({
        boot: text
          .optional()
          .describe(
            "The kernel's identifier of the boot (kern.bootsessionuuid); a different one at the next start means the Mac restarted.",
          ),
        bootedAt: text
          .optional()
          .describe(
            "When the Mac booted (kern.boottime), for people to read; never compared.",
          ),
        login: text
          .optional()
          .describe(
            "The audit session of the user's GUI login (launchd gui domain); a different one in the same boot means the user logged in again.",
          ),
        seenAt: text.describe(
          "When rigd last recorded this session, once it had acted on any restart it found.",
        ),
        restart: z
          .object({
            kind: hostRestart,
            boot: text
              .optional()
              .describe("The boot rigd found when it detected the restart."),
            login: text
              .optional()
              .describe(
                "The login session rigd found when it detected the restart.",
              ),
            seq: z
              .number()
              .int()
              .nonnegative()
              .optional()
              .describe(
                "The state's startSeq when the restart was recorded: a run with a higher startSeq was started after it, and the restart's stop never applies to it. Absent on a restart an older rigd recorded.",
              ),
            settled: z
              .array(text)
              .optional()
              .describe(
                "The Targets (by id) already settled for this restart: stable Targets started again, or whose start failed, and working Targets and Previews whose stopped Services were recorded as stopped by it. A daemon that finds the restart again does not act on them a second time.",
              ),
            unannounced: z
              .literal(true)
              .optional()
              .describe(
                "The restart's Activity entry could not be written yet; the daemon that finds the restart again writes it.",
              ),
            unannouncedBefore: z
              .array(
                z.object({
                  kind: hostRestart,
                  boot: text
                    .optional()
                    .describe(
                      "The boot rigd found when it detected that restart.",
                    ),
                  login: text
                    .optional()
                    .describe(
                      "The login session rigd found when it detected that restart.",
                    ),
                }),
              )
              .optional()
              .describe(
                "Earlier Host restarts, oldest first, whose Activity entries no daemon could write before this restart was found; their entries are written ahead of this one's. Only an unannounced restart carries any.",
              ),
          })
          .optional()
          .describe(
            "A Host restart rigd found but has not finished acting on, recorded in Activity unless marked unannounced; a daemon that finds it again does not record it twice.",
          ),
      })
      .optional()
      .describe(
        "The boot and login session rigd last acted on, so its next start can tell whether the Host restarted in between.",
      ),
  })
  .superRefine((state, ctx) => {
    const ids = new Set<string>(),
      names = new Set<string>(),
      targetIds = new Set<string>(),
      targetNames = new Set<string>();
    for (const project of state.projects) {
      if (ids.has(project.id) || names.has(project.name))
        ctx.addIssue({
          code: "custom",
          message: "Duplicate Project identity.",
        });
      ids.add(project.id);
      names.add(project.name);
    }
    for (const target of state.targets) {
      if (
        !ids.has(target.projectId) ||
        targetIds.has(target.id) ||
        targetNames.has(`${target.projectId}:${target.name}`)
      )
        ctx.addIssue({ code: "custom", message: "Invalid Target identity." });
      targetIds.add(target.id);
      targetNames.add(`${target.projectId}:${target.name}`);
      const owner = state.projects.find((p) => p.id === target.projectId);
      if (
        target.kind !== target.plan.target ||
        target.name !== target.plan.deploymentName ||
        target.plan.project !== owner?.name
      )
        ctx.addIssue({
          code: "custom",
          message: "Target plan identity differs from its record.",
        });
      const components = new Set<string>();
      for (const component of target.plan.components) {
        if (
          components.has(component.name) ||
          component.dependsOn.some((d) => !components.has(d))
        )
          ctx.addIssue({
            code: "custom",
            message: "Component identities or dependency order are invalid.",
          });
        components.add(component.name);
      }
    }
  });

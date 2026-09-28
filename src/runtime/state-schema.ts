import { isAbsolute } from "node:path";
import { z } from "zod";
import { MAX_STOP_TIMEOUT_SECONDS } from "../domain/stop-budget";
const text = z.string().min(1);
/** Registered paths are stored absolute, so comparing two of them never depends on rigd's working directory. */
const absolutePath = text.refine(isAbsolute, {
  message: "must be an absolute path",
});
const envFiles = z
  .array(z.object({ path: absolutePath, required: z.boolean() }))
  .optional();
const commandInputs = z
  .array(z.object({ name: text, source: text, value: z.string() }))
  .optional();
const common = {
  name: text,
  env: z.record(z.string(), z.string()),
  envFiles,
  commandInputs,
  dependsOn: z.array(text),
};
const component = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("managed"),
    command: text,
    port: z.number().int().min(1).max(65535).optional(),
    ports: z.record(text, z.number().int().min(1).max(65535)).optional(),
    sitePort: z.number().int().min(1).max(65535).optional(),
    health: text.optional(),
    readyTimeout: z.number().positive(),
    stopTimeout: z
      .number()
      .int()
      .min(1)
      .max(MAX_STOP_TIMEOUT_SECONDS)
      .optional(),
    restart: z.enum(["always", "on-failure", "no"]).optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("installed"),
    entrypoint: text,
    installName: text.optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("persistent"),
    uses: z.literal("sqlite"),
    path: text,
  }),
]);
export const targetPlanSchema = z.object({
  project: text,
  target: z.enum(["local", "live", "preview"]),
  workspacePath: text,
  dataRoot: text,
  deploymentName: text,
  branchSlug: text,
  subdomain: z.string(),
  branch: text.optional(),
  commit: text.optional(),
  providers: z.object({ processSupervisor: text }),
  env: z.record(z.string(), z.string()).optional(),
  daemon: z
    .object({
      enabled: z.boolean().optional(),
      keepAlive: z.boolean().optional(),
    })
    .optional(),
  components: z.array(component),
  builds: z
    .array(
      z.object({
        id: text,
        component: text.optional(),
        command: text,
        timeout: z.number().positive(),
        commandInputs,
      }),
    )
    .optional(),
  preparedComponents: z.array(
    z.discriminatedUnion("uses", [
      z.object({ name: text, uses: z.literal("sqlite"), path: text }),
      z.object({ name: text, uses: z.literal("convex"), stateDir: text }),
      z.object({ name: text, uses: z.literal("postgres"), dataDir: text }),
    ]),
  ),
  domain: text.optional(),
  proxy: z
    .object({
      upstream: text,
      routes: z
        .array(
          z.object({
            prefix: text,
            service: text,
            port: z.number().int().min(1).max(65535),
          }),
        )
        .optional(),
    })
    .optional(),
  installTimeout: z.number().positive().optional(),
  envFiles,
});
const preparation = z
  .object({
    deployment: text.describe(
      "The workspace the outcomes belong to; outcomes never carry over to another workspace.",
    ),
    units: z.record(
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
        commit: text.optional(),
        startedAt: text,
        finishedAt: text.optional(),
      }),
    ),
  })
  .optional();
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
        "The workspace the Service was started from; a record of another Deployment describes nothing.",
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
            kind: z.literal("exited"),
            exitCode: z.number().int().optional(),
            signal: text.optional(),
            recordedBy: z
              .enum(["launchd", "rigd"])
              .optional()
              .describe(
                "Who saw the end when the application's own exit record was missing: launchd's record of its capture wrapper's job, or rigd's record of the wrapper it spawned.",
              ),
            at,
          }),
          z.object({
            kind: z.enum(["activation-failed", "start-failed"]),
            errorCode: text,
            at,
          }),
          z.object({
            kind: z.literal("unknown"),
            hostRestart: hostRestart
              .optional()
              .describe(
                "The process is gone because of this Host restart; a Working copy or Preview Service is not started again before rig up.",
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
    }),
  )
  .optional()
  .describe("Intent and known process outcomes per managed Service name.");
const project = z.object({
  id: text,
  name: text,
  repoPath: absolutePath,
  configPath: absolutePath,
  createdAt: text,
});
const target = z.object({
  id: text,
  projectId: text,
  name: text,
  kind: z.enum(["local", "live", "preview"]),
  branch: text.optional(),
  commit: text.optional(),
  plan: targetPlanSchema,
  desired: z.enum(["running", "stopped"]),
  createdAt: text,
  updatedAt: text,
  logRoot: text,
  sourceRoot: text.optional(),
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
      "Revision of the rig.yaml a Working copy plan was made from, for reporting drift.",
    ),
  recovery: z
    .object({
      plan: targetPlanSchema,
      preparation,
      branch: text.optional(),
      commit: text.optional(),
      desired: z.enum(["running", "stopped"]),
      deploymentIncomplete: z
        .literal(true)
        .optional()
        .describe("The rollback plan has not completed a deployment."),
      stage: z.enum(["pending", "blocked", "committing"]),
    })
    .optional(),
});
const operation = z.object({
  id: text,
  projectId: text.optional(),
  project: text.optional(),
  target: text.optional(),
  action: text,
  outcome: z.enum([
    "started",
    "stopped",
    "deployed",
    "failed",
    "unchanged",
    "registered",
    "renamed",
    "repointed",
    "installed",
    "uninstalled",
  ]),
  occurredAt: text,
  message: z.string().optional(),
});
const instant = z
  .string()
  .datetime({ offset: true })
  .describe("An ISO 8601 time.");
const downService = z.object({
  name: text.describe("The Service's name."),
  reason: z.string().describe("The reason status gives for the Service."),
  brief: z
    .string()
    .describe("The same reason in a few words, for a short notification."),
});
const resolution = z.object({
  at: instant.describe("When the down period ended."),
  how: z
    .enum(["running", "stopped", "removed"])
    .describe(
      "running: it serves again; stopped: an operator stopped it; removed: it is no longer recorded.",
    ),
});
const alerts = z
  .object({
    targets: z
      .array(
        z.object({
          targetId: text.describe("The Stable Target's record id."),
          project: text.describe("The Project's name when last seen."),
          target: text.describe("The Stable Target's name when last seen."),
          since: instant.describe("When Rig first counted it as down."),
          services: z
            .array(downService)
            .describe("The Services that keep it down."),
          unpublishedRoute: text
            .optional()
            .describe(
              "Its route, when the host Caddy does not load Rig's routes.",
            ),
          recover: text.describe(
            "The command that starts it again, as alerts, doctor and rigd status show it.",
          ),
          alertedAt: instant
            .optional()
            .describe(
              "When the alert naming it was delivered; absent until then.",
            ),
          resolved: resolution
            .optional()
            .describe(
              "The down period ended; kept until the recovery message is delivered.",
            ),
        }),
      )
      .describe(
        "Stable Targets counted as down, and alerted ones whose recovery is not yet told.",
      ),
    notifiedAt: instant
      .optional()
      .describe(
        "When the last down alert or reminder was delivered; reminders are timed from it.",
      ),
    retry: z
      .object({
        failures: z
          .number()
          .int()
          .positive()
          .describe("Deliveries that failed in a row."),
        at: instant.describe("When the next delivery may be tried."),
      })
      .optional()
      .describe("The wait after a failed delivery."),
  })
  .optional()
  .describe(
    "Operator alert state: what was alerted and when, so a daemon restart neither repeats nor forgets an alert.",
  );
/** The state file format this rigd writes. Bump it whenever a record gains or changes a field so that an
 * older rigd refuses the file instead of silently dropping what it does not know. A new optional top-level key, such
 * as `alerts`, needs no bump: an older rigd validates without it and writes it back unchanged. After such a downgrade and a
 * re-upgrade, `alerts` is as the newer rigd last left it; its next evaluation reconciles it with the Targets as they are then,
 * so an outage that ended meanwhile is told as recovered and one that began meanwhile starts its grace period then. */
export const STATE_VERSION = 4;
export const runtimeStateSchema = z
  .object({
    version: z.literal(STATE_VERSION),
    projects: z.array(project),
    targets: z.array(target),
    activity: z.array(operation),
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
            settled: z
              .array(text)
              .optional()
              .describe(
                "The Targets (by id) already settled for this restart: Stable Targets started again, or whose start failed, and Working copies and Previews whose stopped Services were recorded as stopped by it. A daemon that finds the restart again does not act on them a second time.",
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
    alerts,
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

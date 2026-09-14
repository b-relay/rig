# Open issue priority order — 2026-09-14

Every open issue on b-relay/rig, ordered by how much it threatens the
functionality and reliability of Rig for a user running Projects on their Mac.
Highest first. Honesty issues (#224-#237) are placed next to the bug they
unblock when they are themselves a functional defect, and in their own tier
otherwise. This file is the work queue for the one-by-one resolution pass;
items are struck through and annotated as they close.

Criteria, in order: production outage or data loss · silent wrong behaviour
on a core flow (deploy, up, down, status) · wedged state with no CLI exit ·
reliability across daemon restart and crash · security and confinement ·
diagnostics that send the user the wrong way · usability and minor gaps ·
testability and honesty refactors.

## Tier 0 — outage, data loss, or destructive misdirection

1. ~~#222~~ (fixed) Generated proxy Caddyfile is never loaded by the running Caddy; routes are inert while doctor says healthy. Rig's core promise is broken and nothing reports it.
2. ~~#191~~ (fixed) Convex stateDir and relative sqlite paths resolve inside the per-deploy checkout; every live/preview deploy starts with an empty database. Silent data loss on every deploy.
3. ~~#208~~ (fixed) `rig down preview <branch> --deployment other --destroy` destroys a different Preview than the one named. Destructive command hits the wrong target.
4. ~~#174~~ (fixed) `deploy --no-up` on a running live Target stops and retires the previous build; nothing serves until `rig up`. Production outage from a documented flag.
5. ~~#190~~ (fixed) A typo in `providers.processSupervisor` stops production on deploy and blocks rollback and down. Schema accepts it, no exit.
6. ~~#211~~ (fixed) Clean rigd stop kills every managed child and restart re-runs every start hook. Daemon maintenance is an outage.
7. ~~#216~~ (fixed) LaunchAgent records the version-specific bun path; a Homebrew bun upgrade bricks rigd and every command says unreachable.
8. ~~#217~~ (fixed) LaunchAgent KeepAlive with no throttle: a failing rigd relaunches every 10 s forever, grows startup.log without bound, cannot be uninstalled through the CLI.
9. ~~#143~~ (fixed) Capture wrapper rewrites a running component as failed and exits, orphaning the detached child. Unsupervised production process.
10. ~~#212~~ (fixed) Lease recovery binds to the sh group leader only and drops keepAlive: dead leader reads stopped, next up spawns a duplicate; recovered processes never restart.
11. ~~#199~~ (fixed) Interpolated paths inserted into shell commands unquoted; a workspace or RIG_ROOT with a space breaks every component command.
12. ~~#223~~ (fixed) `rig deploy live` resolves the Project from cwd with no echo or confirmation; running it in another checkout redeploys that project.
13. ~~#219~~ (fixed) `down preview --destroy` persists destructionPending before preconditions; a refused destroy wedges the Preview with processes running and blocks uninstall.
14. ~~#151~~ (fixed) Crash between an applied effect and its journal capture bricks the Target: down, up, deploy, destroy all fail with hints pointing at each other.
15. ~~#147~~ (fixed) CLI sends the bearer token to whatever process owns a stale daemon port.
16. ~~#204~~ (fixed) Every client deadline expiry is reported as DAEMON_UNREACHABLE while rigd keeps executing; retry queues a duplicate deploy.
17. ~~#210~~ (fixed) status/doctor during a normal in-flight deploy say "run down to stop both recorded plans"; following the hint stops the freshly deployed build.
18. ~~#155~~ (fixed) `up` starts a Deployment whose commit never completed and never clears deploymentIncomplete; next same-Commit deploy restarts a healthy Target.

## Tier 1 — core flows silently wrong or wedged

19. ~~#171~~ (fixed) `rig up` certifies readiness without re-observing the process: crashed component reported started, foreign listener passes health.
20. ~~#194~~ (fixed) `rig restart` aborts after the stop half when a stop hook fails; desired persisted as stopped, up never runs.
21. ~~#187~~ (fixed) git push rig / rig deploy plan the Target from the working-copy rig.yaml, not the pushed commit.
22. ~~#186~~ (fixed) After a failed first Preview deploy, git push rig reports "Everything up-to-date" forever, even with --force.
23. ~~#214~~ (fixed) git push interrupted mid-deploy: helper has no signal handling, in-flight commit advertised as the remote ref, re-push says up-to-date.
24. ~~#160~~ (fixed) git push rig hangs forever when the helper hits a fatal error.
25. ~~#136~~ (fixed) up/restart on an existing local Target never re-plans from current config; deploy local is rejected, so config changes cannot be applied.
26. ~~#221~~ (fixed) Recorded local Target is never re-planned after a port change and cannot be dropped; live deploy hits PORT_RESERVED with no exit.
27. ~~#123~~ (fixed) Preview replacement: retire failure after the new Preview is committed records the deploy failed and leaves the Project permanently over maxActive.
28. ~~#124~~ (fixed) Preview replacement retires the oldest Preview without destroying its storage; orphaned data root with no cleanup handle.
29. ~~#188~~ (fixed) Preview replacement is silent and state-blind: stopped and failed Previews count toward maxActive, the oldest running one is evicted.
30. ~~#220~~ (fixed) Pre-#113 Preview records without sourceRoot can never be destroyed.
31. ~~#125~~ (fixed) Convex site port selected by the runtime is discarded for local/live; plan records port+1, which can collide.
32. ~~#175~~ (fixed) Port reservation ignores the recovery.plan of a Target in recovery; two Targets can be planned onto the same port.
33. ~~#152~~ (fixed) repoint re-plans local Targets without the port reservation check; two Targets can record the same port.
34. ~~#196~~ (fixed) Hook semantics drift from the schema: hooks on installed components never run, postStart runs before readiness.
35. ~~#144~~ (fixed) launchd ensureRunning fails LAUNCHD_START on a healthy job in restart backoff. (#227 is its honesty fix.)
36. ~~#202~~ (fixed) launchd capture observation measures freshness after two ps inspections; loaded hosts flap to unknown and block uninstall. (#228, #237.)
37. ~~#218~~ (fixed) launchd supervisor litter and the ~3 s unload budget fails `rig down` while the job is unloading. (#227, #226.)
38. ~~#229~~ (fixed) Honesty and functional: installer resolves bun through `Bun.which` on the launchd PATH; every source-entrypoint install fails BUN_MISSING for a user-local bun.
39. ~~#231~~ (fixed) Honesty and functional: git source store resolves relative repository/destination against rigd's cwd.
40. ~~#157~~ (fixed) sqlite path and envFile are not confined; rigd creates directories and files at any user-writable absolute path.
41. ~~#135~~ (fixed) Localhost-only binding check bypassed by a quoted shell wrapper; hooks and env not checked.
42. ~~#173~~ (fixed) Health URL localhost validation bypassed by userinfo quote or uppercase scheme; rigd polls an arbitrary host.
43. ~~#156~~ (fixed) Installer shell environment inherited by rigd and every component and hook, persisted to capture/launchd JSON. (#229, #232.)
44. ~~#195~~ (fixed) Installation receipt key hashes the whole daemon environment; a restart from another shell rebuilds every installed component.
45. ~~#192~~ (fixed) Renaming a component while keeping its installName fails every later deploy with ARTIFACT_CONFLICT; on local, up never re-runs build.
46. ~~#163~~ (fixed) Lane override replaces the whole hooks object while env merges per key.
47. ~~#162~~ (fixed) `rig init --domain` scaffolds the same hostname for every Target; second Target fails ROUTE_CONFLICT.
48. ~~#159~~ (fixed) Symlinked rig.yaml or Caddyfile silently replaced by a regular file on first edit.
49. ~~#153~~ (fixed) Superseded revisions, worktrees and prepared markers never removed; disk grows every deploy. (#231.)

## Tier 2 — daemon and state robustness, admin dead ends

50. ~~#181~~ (fixed) Corrupt or empty state.json makes rigd exit silently; doctor says healthy; uninstall dead-ends.
51. ~~#182~~ (fixed) state.json write has no fsync and no backup; the only recovery hint refers to a file that never exists.
52. ~~#183~~ (fixed) state.json parses in strip mode; a downgrade silently drops destructionPending/deploymentIncomplete.
53. ~~#185~~ (fixed) Effect journal schema is strict; a newer journal bricks the Target on downgrade; orphan journals never reclaimed.
54. ~~#138~~ (fixed) Stale owner.json/address.json pid reused by another process bricks install, uninstall and start.
55. ~~#139~~ (fixed) Stale daemon/acquiring lock is unrecoverable through the CLI.
56. ~~#140~~ (fixed) A cleanly stopped rigd cannot be uninstalled: DAEMON_UNCERTAIN with a dead-end hint.
57. ~~#132~~ (fixed) A reachable daemon without install.json cannot be uninstalled.
58. ~~#131~~ (fixed) runDaemonHost.release() throws on corrupt address/owner JSON, masking the startup error.
59. ~~#130~~ (fixed) Stale admin-activity.jsonl.lock silently disables administration Activity forever.
60. ~~#184~~ (fixed) rigd install cannot upgrade a running daemon; protocol skew reported as "Invalid Rig command".
61. ~~#137~~ (fixed) rigd SIGTERM force-closes in-flight commands; client reports unreachable while the operation completes.
62. ~~#213~~ (fixed) One global mutation queue: a slow hook in one Project blocks every other Project with no feedback. (#234.)
63. ~~#145~~ (fixed) Legacy migration roots have no caller; adoption guard can wedge rigd with no command to finalize.
64. ~~#122~~ (fixed) RIG_ROOT="" makes rig use the current working directory as the Rig root (caused a real incident on this machine).
65. ~~#121~~ (fixed) Empty or unreadable control-plane token reported as "not installed"; install then crashes with raw EEXIST. (#224.)
66. ~~#116~~ (fixed) Distinguish missing daemon tokens from invalid or unreadable token state.
67. ~~#158~~ (fixed) Stale rig.yaml.lock after a crashed config edit blocks every later edit.
68. ~~#166~~ (fixed) Deleting a Target log directory while a component runs silently drops all further output.
69. ~~#168~~ (fixed) Diagnostic log rotation permanently disabled after one partial record; log grows without bound.
70. ~~#165~~ (fixed) Target log reader cannot get past one bad record; logs and --follow fail until >4 MiB of newer output.
71. ~~#207~~ (fixed) `rig logs --follow` never exits when stdout is closed; orphan CLI polls rigd every 250 ms.
72. ~~#141~~ (fixed) state.activity grows without bound and records usage mistakes as failed Operations.
73. ~~#197~~ (fixed) Hook, build or install timeout reported as generic COMMAND_TIMEOUT with all output discarded; timeouts hard-coded.
74. ~~#172~~ (fixed) Missing envFile fails deploy with a raw ENOENT turned into UNEXPECTED; path lost.
75. ~~#198~~ (fixed) envFile parser rejects `KEY="value" # comment`; ENV_FILE errors carry no path or line.
76. ~~#146~~ (fixed) launchd request JSON non-atomic; child observe probes with process.kill(0) bypassing ProcessInspection. (#225.)
77. ~~#120~~ (fixed) Make child-supervisor stop and restart timing explicitly controllable. (Honesty issue for child stop/scheduleRestart; #225, #226.)

## Tier 3 — diagnostics that mislead

78. ~~#201~~ (fixed) status never reports destructionPending or deploymentIncomplete; doctor reports an uncommitted deployment healthy.
79. ~~#200~~ (fixed) doctor discards the observation reason and exit code for every failing component. (#234.)
80. ~~#126~~ (fixed) doctor reports config-invalid for a valid config that adds a managed component without a port.
81. ~~#154~~ (fixed) doctor config-drift hint says "Deploy to apply" but a same-Commit deploy is unchanged.
82. ~~#127~~ (fixed) doctor treats a slow daemon (>5 s) as absent. (#224, #234.)
83. ~~#119~~ (fixed) Make Doctor use one Project config snapshot and distinguish inspection failures.
84. ~~#118~~ (fixed) Make runtime diagnostic and monitor failures observable without changing outcomes.
85. ~~#117~~ (fixed) Preserve safe initiating and recovery causes in retirement failures.
86. ~~#205~~ (fixed) Caddy validate/reload stderr discarded on every path; missing caddy executable is a generic COMMAND_START. (#230.)
87. ~~#177~~ (fixed) Moving a registered repo is a dead end; conflicting path never shown. (#236.)
88. ~~#148~~ (fixed) Editing the Project name in config after registration is a circular dead end. (#235.)
89. ~~#161~~ (fixed) git push rig from a linked git worktree rejected with PROJECT_PATH_CONFLICT. (#232, #236.)
90. #178 `rig init --path <dir>` registers the Git toplevel and ignores a nearer rig.yaml. (#233.)
91. #179 Non-interactive init records the checked-out branch as Production; host default never consulted. (#233.)
92. #167 `rig activity` hides the message and Operation id.
93. #149 User-correctable failures rendered as unexpected; raw Zod text; no CLI pre-validation.
94. #164 Config validation gaps: "Invalid input" for common mistakes, no field path.
95. #176 Health/readiness minor gaps: 3xx unhealthy with no reason, evidence discarded, readyTimeout overflow.
96. #115 Validate inventory, Logs and Activity replies before rendering empty results.
97. #128 First Ctrl-C after submit silently consumed; second hard-kills with no diagnostic.
98. #129 Ctrl-C at an interactive prompt exits 1 with an error; elsewhere exits 0 silently.
99. #134 Output strips fewer control characters than prompts.

## Tier 4 — minors

100. #203 doctor/status/list minors (aggregate never unhealthy, list observes every Target, status omits Commit). (#234.)
101. #206 Caddy router and daemon minors (port-unaware conflict check, remove of absent route reloads, Origin check).
102. #189 Preview push minors.
103. #215 git-remote-rig minors (hijack hint, success line, --force same-commit, --all).
104. #180 Registration minor gaps. (#233, #235.)
105. #193 Provider minors (Postgres encoding, pg.url scheme, generic missing-binary errors, bin/ collisions).
106. #169 Logs/diagnostics minors.
107. #209 CLI minors.
108. #150 Minor CLI gaps (no --version, hashed slug in messages).
109. #142 Minor daemon/CLI messaging gaps.

## Tier 5 — honesty refactors not themselves functional defects

Ordered by how many `[T]` ancestors each clears and which bugs above it unblocks.

110. #225 createChildSupervisor / createProcessInspection defaults; composeDaemon passes none. Unblocks #120, #146, #171, #211, #212.
111. #234 Runtime observation deadline chosen by omission in four call sites. Unblocks #200, #203, #210, #213 tests.
112. #226 waitForCaptureStart Date.now/Bun.sleep. Shared by both supervisors.
113. #227 launchd waitForApplication/stop uninjectable sleeps. Unblocks #144, #218.
114. #228 createLaunchdSupervisor defaults run/inspect/now.
115. #237 createProcessIdentityReader default run, called bare by the wrapper. Unblocks #143 test.
116. #232 createProjectDiscovery captures process.env. Unblocks #156, #161, #178 tests.
117. #233 inspectInitialization hidden readProjectConfig. Unblocks #178, #179, #180.
118. #230 createCaddyRouter default run. Unblocks #205 daemon-level test.
119. #235 updateRegistration mutates project.name with void return.
120. #236 selectProject/registerProject resolve against cwd (latent).
121. #224 inspectOfflineHost hard-wires inspectHost/discoverProject.

## Not in the queue

122. #114 Redesign the project config (enhancement; a design project, not a defect).

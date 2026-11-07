---
status: accepted; its rule that an unknown exit overrides `always` is superseded by [#274](https://github.com/b-relay/rig/issues/274)
---

# Separate explicit starts from automatic restart policy

For [#114](https://github.com/b-relay/rig/issues/114), `restart: no` leaves an exited Service stopped across daemon restarts, while explicit `up` or `restart` can start it again. A surviving Service remains running without a duplicate launch, and `down` retains stopped intent. The setting means no automatic restart, not once-per-deploy execution.

On September 16 the user requested durable exit evidence and a manual-start fallback when evidence is missing after a crash, and subsequently accepted that this overrides `always` too. Persist observed exit outcomes, but do not infer a known cause from absence: sudden host loss can prevent the final write. A process verified as still running is left running; a known exit follows its selected restart policy.

Superseded for `always` by [#274](https://github.com/b-relay/rig/issues/274), since a Service killed together with its exit recorder otherwise stayed down for good. An unknown exit under `on-failure` or `no` still needs `rig up`. Under `always` it is started again once its ports accept no connection, on a budget of its own (`UNKNOWN_EXIT_RESTART_*` in `src/runtime/supervision.ts`): three attempts within any 10 minutes, 5 seconds, 1 minute and 5 minutes after the exit. The exception is a Host restart or a new login ([#283](https://github.com/b-relay/rig/issues/283)): the working Target and Previews then retry no unknown exit, whatever the policy, until `rig up`. The guide's "Automatic restart" section has the details.

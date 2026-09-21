---
status: accepted
---

# Separate explicit starts from automatic restart policy

For [#114](https://github.com/b-relay/rig/issues/114), `restart: no` leaves an exited Service stopped across daemon restarts, while explicit `up` or `restart` can start it again. A surviving Service remains running without a duplicate launch, and `down` retains stopped intent. The setting means no automatic restart, not once-per-deploy execution.

On September 16 the user requested durable exit evidence and a manual-start fallback when evidence is missing after a crash, and subsequently accepted that this overrides `always` too. Persist observed exit outcomes, but do not infer a known cause from absence: sudden host loss can prevent the final write. A process verified as still running is left running; a known exit follows its selected restart policy.

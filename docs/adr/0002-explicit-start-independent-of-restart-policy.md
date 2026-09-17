---
status: accepted
---

# Separate explicit starts from automatic restart policy

For [#114](https://github.com/b-relay/rig/issues/114), `restart: no` leaves an exited Service stopped across daemon restarts, while explicit `up` or `restart` can start it again. A surviving Service remains running without a duplicate launch, and `down` retains stopped intent. This deliberately replaces the current behavior in which daemon startup can revive a stopped process despite `keepAlive: false`; it makes the setting mean no automatic restart rather than once-per-deploy execution.

On September 16 the user requested durable exit evidence and a manual-start fallback when evidence is missing after a crash, and subsequently accepted that this overrides `always` too. Persist observed exit outcomes, but do not infer a known cause from absence: sudden host loss can prevent the final write. A process verified as still running is left running; a known exit follows its selected restart policy.

This is an accepted design decision, not implemented behavior. The [accepted specification](../../plans/114-config-spec.md#q23-runtime-outcomes-readiness-and-activation) defines known-exit classifications, durable retry budgets and reset events.

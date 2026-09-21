---
status: accepted
---

# Build once for a Deployment, then reuse the result

For [#114](https://github.com/b-relay/rig/issues/114), the user chose deployment-time builds with recorded completion instead of a pre-start hook that repeats on every start. A completed build is reused by subsequent starts and restarts of that Deployment, including materialization without activation.

The user approved one explicit Project shared build plus optional Service/Tool builds, without deduplicating matching command strings. If a build may have finished but lacks a durable success record, report unknown completion and require explicit retry. Explicitly starting/restarting the Working copy builds current source; automatic restarts reuse the result. The [guide](../rig-guide.md) documents build identity, missing artifacts, ordering and build budgets.

This is not an exactly-once guarantee for arbitrary shell side effects.

---
status: accepted
---

# Cut over user-authored Rig config to YAML only

For [#114](https://github.com/b-relay/rig/issues/114), Project config will use only `rig.yaml` and the new schema after a hard cutover. On September 16 the user included Host config in the same YAML-only cutover: `config.yaml` replaces user-authored Host JSON. The user chose one supported format over maintaining two readers, keeping the configuration contract small at the cost of an explicit migration.

Machine-owned runtime records may remain JSON. A planned stop/start window per Target is acceptable for migration; application data must be preserved. Migration mechanics and rollback still require a concrete plan, and this decision does not execute or schedule a live cutover.

This is an accepted design decision, not a claim that the cutover is implemented.

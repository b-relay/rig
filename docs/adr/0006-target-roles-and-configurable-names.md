---
status: accepted
---

# Separate Target roles from their configurable names

For [#114](https://github.com/b-relay/rig/issues/114), the user accepted one Working copy Target and one Stable Target plus generated Previews. Configuration uses the fixed role keys `working`, `stable` and `preview`; Working copy and Stable display names default to `local` and `live` and can be renamed. A role-keyed shape makes the supported Target count clear without a discriminator on every named entry, while the name metadata preserves the user's preferred CLI vocabulary.

Display names do not rename roles, secret-file scopes or stable storage identities. Independent Branch mappings/multiple Stable Targets and removal of inherited Services remain deferred. This records the final correction from the prototype's `local` role key to `working`; it is not a claim that runtime support has shipped.

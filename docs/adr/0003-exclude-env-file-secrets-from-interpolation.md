---
status: accepted
---

# Keep environment-file secrets out of Rig interpolation

For [#114](https://github.com/b-relay/rig/issues/114), secret values loaded from environment files enter the child process environment but never Rig's config or command interpolation. This keeps machine secrets out of resolved commands and persisted plans, at the cost of separating public configuration references from the final process environment. The user explicitly chose this boundary.

This is an accepted design decision, not a claim that every proposed environment behavior is implemented. It does not promise that arbitrary application output cannot contain secrets.

On September 16 the user required an explicit resolution order and visibility into shadowed names/sources, then approved rejecting a conflicting env-file override of a public value used in a command. Name the competing key/sources without exposing secret values. Ordinary non-conflicting overrides remain explainable; the complete precedence and evaluation contract will be specified in the design.

---
status: accepted
---

# User-authored Rig config is YAML only

For [#114](https://github.com/b-relay/rig/issues/114), Project config is `rig.yaml` and Host config is `config.yaml`, and Rig reads nothing else. The user chose one supported format over maintaining two readers, keeping the configuration contract small. Rig has no JSON reader and no migration command.

Machine-owned runtime records may remain JSON.

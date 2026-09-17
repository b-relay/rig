---
status: accepted
---

# Keep applications independent of Rig

For [#114](https://github.com/b-relay/rig/issues/114), Rig provides deployment conveniences while applications consume ordinary inputs they define: command-line arguments, environment variables and filesystem paths. Project configuration explicitly maps Rig-generated values such as ports and `rig.data` to those application inputs; Rig resolves its expressions before invoking the application. An application must not need a Rig SDK, Rig-specific variable names, interpolation parser, directory layout or runtime API to perform its normal work.

Another deployment platform or a person must be able to supply equivalent inputs and run the same application. Rig-specific deployment configuration is allowed; platform coupling belongs in that configuration, not in application logic. This trades implicit platform magic for explicit mappings and does not imply that every operating system can run every application unchanged.

---
status: accepted
---

# A forgotten Project's Tools stay installed, released to the next owner

## Problem

A Target publishes each Tool into `<RIG_ROOT>/bin`, shared by every Project, and records its ownership in `<RIG_ROOT>/installed/owners/<sha256(path)>.json`: the owning Target id, its names, and `revision`, the SHA-256 of the bytes it published. Only that Target may replace or retire the file; any other is refused with `ARTIFACT_CONFLICT`.

`rig forget` dropped the Project's records but left its Tools and their ownership records ([#343](https://github.com/b-relay/rig/issues/343)). The same repository registered again gets new Target ids, so its deploy was refused `ARTIFACT_CONFLICT` against a Target nothing records, for as long as the Rig root existed. It is the Tool form of #336, which ADR 0014 fixed for routes ("A block lives no longer than its Target").

## Decision

**`forget` leaves the files in place and changes nothing about them.** The write that drops the registration is what releases them: a Tool whose ownership record names a Target no state record names is _released_. Removing the files was rejected:

- A Tool is a command on the user's `PATH`. A forget is not Project deletion (see `CONTEXT.md`): it leaves the repository, the workspace and the data on disk, and a stale binary that still runs is a smaller surprise than a command that vanished.
- Rig's own Project publishes `rig` and `rigd`, and rigd's system job runs `<RIG_ROOT>/bin/rigd`. Removing it on a forget of that Project would leave launchd nothing to start after a crash or reboot.
- Nothing about the Tools changes before the state write, so nothing needs compensating when it fails, unlike a route withdrawal. A write that does not commit leaves the Project registered and its Tools owned; one that commits and then fails its directory sync is a completed forget (reported with #342's warning) and its Tools are released; a state that cannot be read back is `FORGET_UNCERTAIN`, and the Tools follow whichever the state says. The forget's warnings name the Tools left in `bin/`, and caution against deleting `bin/rigd`.

**The next Target that publishes at a released path takes it over**, from any Project, through the same checkpointed install as any publication (the old bytes and ownership record are backed up and restored by a rollback), replacing the file by atomic rename. The running process keeps its inode, so taking over `bin/rigd` is the same step an upgrade is. This needs no step from the user, so Hosts where an earlier forget already left Tools recover by themselves. Releasing is decided at the one place every publication passes, `ArtifactOwnership.inspect`, from a reader of the recorded Target ids that rigd hands the effects adapter, so the provider holds no state. It is read only when another Target asks for a path, after the ownership record; every Target is recorded before it publishes a Tool (a deploy persists its candidate first, `up` its planned Target), so a Target being created is never taken for released. Absent a reader, nothing is released.

**Rig never replaces or removes bytes it did not publish.** A released Tool whose bytes differ from its recorded `revision` is refused with `ARTIFACT_CHANGED`, saying its Target no longer exists and to move or delete the file; a released Tool that is gone frees its path. A Target that retires a path it never owned (a Preview destroy, a superseded Tool) leaves a released Tool there alone and removes only its own receipt.

**No automatic sweep removes released Tools.** A sweep like the route sweep would delete files on rigd start, including `bin/rigd` and `bin/rig` should a state file ever be lost. Doctor reports instead: `tool-owners` names every Tool in `bin/` whose owner Target is not recorded, released or changed, with how each is recovered, and warns never to delete `bin/rig` or `bin/rigd`. It reads the ownership records before the state, so a deploy in progress is never reported; a forget running meanwhile can be, once, as with `route-owners`.

## Threat model

As in ADR 0014: the revision check guards against a Tool edited by hand at rest and against a misconfiguration, not against the same user rewriting `<RIG_ROOT>/bin` while a publication is in flight (between the digest and the rename). That user can replace any file there directly.

## Consequences

- A forgotten Project's Tool name is free for any Project at once, while its file keeps working until then.
- Stale binaries can remain in `bin/` until a Target publishes the same name or the user deletes them; doctor keeps naming them.
- An ownership record whose file the user deleted stays on disk, unreported, until a Target publishes there. Its receipts stay too; nothing reads either.

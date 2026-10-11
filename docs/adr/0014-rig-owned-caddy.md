---
status: proposed
---

# Rig runs the Host's one Caddy and terminates TLS

## Today

Two Caddy processes serve every Rig hostname. Both are system LaunchDaemons that start at boot.

**The front Caddy** (`com.b-relay.b-caddy`, user `b-caddy`):

- Starts through the b-secret broker, which injects the Cloudflare token.
- Listens on `*:80` and `*:443`.
- Holds a DNS-01 wildcard certificate for `*.b-relay.com`, and gets on-demand DNS-01 certificates for deeper names such as `api.melody` and `private.share`. An "ask" service (`com.b-relay.caddy-ask`) approves each name against the router's Caddyfile.
- Runs Caddy v2.10.2 with caddy-dns/cloudflare, byte-identical to `/usr/local/bin/caddy`.

**The router Caddy** (`com.b-relay.caddy-router`, user clay):

- Receives everything the front Caddy proxies.
- Listens on `127.0.0.1:18080/18443` with `tls internal`, and serves its admin API on `127.0.0.1:2019`.
- Imports Rig's route file, `~/.rig/proxy/Caddyfile`.

Rig itself only edits marked blocks in that route file and runs a reload command from `providers.caddy`. It owns neither the processes, the ports, the certificates, nor most of the configuration, so when something breaks, `rig doctor` can say little more than whether the route file is imported.

## Decision

Rig runs **one Caddy**. That Caddy terminates TLS with Let's Encrypt certificates and routes every Rig hostname, the way Dokploy owns Traefik. Certificates come from ACME DNS-01 through Cloudflare, because the Host's addresses are private Tailscale addresses.

- The front Caddy, the router and the ask service retire, so b-secret and its users can be removed. The owner does that outside Rig.
- The router's own sites (code, core, dev.core, dev.pantry) are deleted, not migrated.
- There are no wildcard routes, and Rig manages no DNS records (since reversed by [ADR 0018](0018-dns-records.md), which manages them with the same token).
- The owner can add routes that are not Rig Projects.
- Sites come up at boot, before anyone logs in, as they do today.

Claims marked as checked were checked with an isolated Caddy on high ports under `/tmp`. The evidence is listed at the end.

The coordinator settled these questions:

- No owner Caddyfile: the owner's own hostnames are structured `proxy.routes` in Host config (the custom Caddy files of earlier drafts are gone; see **Customization**).
- A configured binary that Rig copies and checks; Rig does not download Caddy.
- A connection to an unknown name is closed.
- A scoped token file.
- Boot start is built last, as its own slice, with `login` kept as the default until the owner answers. The owner's answer is expected to be yes, so this Host's cutover requires boot mode.
- `providers.caddy` retires after the rollback window.
- No DNS management (reversed by [ADR 0018](0018-dns-records.md)).

A second hostname on one Target is supported internally. Its rig.yaml syntax is still open: the proposal is a per-Service `domain`, such as `services.api.domain: api.melody.b-relay.com`, whose Preview applies the flat rule (`api-<preview>.melody.b-relay.com`). No schema key exists yet.

## Boot start: rigd and its Caddy as system jobs that run as the user

This section stands alone. It implements [#287](https://github.com/b-relay/rig/issues/287) for rigd as well as for Caddy.

Today `rigd install` loads rigd as a LaunchAgent in `gui/<uid>`, which exists only while the user is logged in at the console. A Caddy started at boot would then proxy to a rigd that is waiting for a login, so it would serve errors until someone logs in. Both therefore become **system jobs that run as the user**.

- **Mode.** Host config gains `daemon.start: boot | login`.
  - `login` is today's LaunchAgent, and stays the default.
  - `boot` installs system jobs.
  - A rigd with `RIG_ROOT` set ignores the setting and runs as a detached process (`process` mode).
  - `install.json`'s `mode` gains `system`.
- **Plists.** Both jobs, `com.b-relay.rigd.<hash>` and `com.b-relay.rig-caddy.<hash>`, have the same shape:
  - `UserName` is the installing user, and `GroupName` is `staff`.
  - `ProgramArguments` points at a stable path under the root.
  - `WorkingDirectory` is the root.
  - `EnvironmentVariables` sets `HOME`, `USER`, `LOGNAME`, `LANG`, `RIG_ROOT` and a fixed `PATH` (`<root>/bin`, `~/.bun/bin`, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and the system directories). Unlike the LaunchAgent, it does not copy the installing shell's environment, whose `PATH` changes from one shell to the next: a root-owned plist that differed on every install would ask for sudo every time.
  - `RunAtLoad` is set, `KeepAlive` is `true`, `ThrottleInterval` is 10 and `Umask` is 63.
  - Logs go to `daemon/startup.log` for rigd and `caddy/launchd.log` for Caddy.

  Rig never writes a plist without `UserName`, so no Rig job runs as root. The existing `com.b-relay.caddy-router` is already a system job that runs Caddy as clay.

- **Upgrades never need sudo.**
  - **Stable paths.** `ProgramArguments` names `<root>/bin/rigd` and `<root>/caddy/bin/caddy`, so upgrades replace what those paths point at and the plist never changes.
  - **Restarting.** Only root can `kickstart` a job in the system domain. Rig instead makes the process exit, and the unconditional `KeepAlive` starts it again. For Caddy that is `POST /stop` on its admin socket. rigd drains and exits as it does on shutdown: Services detach, and the new rigd adopts them (ADR 0007).
  - **Status.** `launchctl print system/<label>` works without sudo (checked), so status and doctor read the job's state.
- **Sudo once, as one chain that stops at the first failure.**
  1. `rigd install` runs as the user and renders the plists it wants into `<root>/daemon/launchd/`.
  2. It compares them with the files in `/Library/LaunchDaemons`.
  3. If they differ, it stops with `DAEMON_SYSTEM_INSTALL` and prints **one line** per job:

     ```sh
     sudo install -d -m 755 -o root -g wheel '/Library/Application Support/Rig' \
     && sudo sh -c 'umask 077; cat > '\''/Library/Application Support/Rig/<label>.plist'\''' < ~/.rig/daemon/launchd/<label>.plist \
     && { echo '<sha256>  /Library/Application Support/Rig/<label>.plist' | sudo shasum -a 256 -c - || { sudo rm -f '…/<label>.plist'; false; }; } \
     && <stopped gui/<uid>/<label>> && rm -f ~/Library/LaunchAgents/<label>.plist \
     && sudo install -m 644 -o root -g wheel '/Library/Application Support/Rig/<label>.plist' /Library/LaunchDaemons/<label>.plist \
     && <stopped system/<label>> && sudo launchctl enable system/<label> \
     && sudo launchctl bootstrap system /Library/LaunchDaemons/<label>.plist
     ```

     `<stopped target>` is `{ <absent> || { launchctl bootout target; <wait up to 20 s until absent>; <absent>; }; }`, where `<absent>` is `launchctl print target` exiting 113 ("Could not find service", checked on macOS 15). Only launchd confirming the job gone decides: not bootout's exit status, which is non-zero while a stop is still in progress, and not any other `print` failure, such as a failed sudo or a refused IPC, which fails the step closed.
  - **What the chain guarantees.**
    - The user's own shell reads the rendered plist, so root never opens a path the user controls. Root only writes what it is handed into a directory only it can write, privately.
    - The digest is checked on that root-owned copy, before anything reaches `/Library/LaunchDaemons` or launchd. A plist changed after rigd printed the line fails the check, its staged copy is deleted, and nothing after the failure runs.
    - A job is stopped only if it is loaded, and the line goes on only once launchd confirms it is gone. A bootout that fails, or that leaves the job loaded, ends the line (tested with a stubbed launchctl).
    - `enable` undoes the emergency rollback's persistent `disable`.
    - Rig never asks the owner to run a script, because a file the user can write, run with sudo, would be a way to gain root.
  - **The LaunchAgent goes last.** Each line replaces the LaunchAgent of the same label, which it stops and removes only once the system plist is verified. A system job and a LaunchAgent are never both enabled for one root, which is what #287 requires.
  - **The record waits.** `install.json` names the system mode only once both jobs are installed. Until then it names the rigd that runs, so a line never pasted leaves nothing recorded wrongly. launchd's rigd learns its mode from `RIG_DAEMON_MODE` in its plist.
  - **Order.** The Caddy line comes first.
  - **Confirming.** The owner runs `rigd install` again to confirm.

- **Going back and uninstalling.** Going back to `login`, or `rigd uninstall` (after its usual checks), prints a `sudo launchctl bootout … && sudo rm …` chain.
- **Without a login.**
  - **Host restart.** rigd's Host session probe reads only the boot, so a "Host restart" means a reboot.
  - **Services.** They run without the login Keychain, `gui/<uid>` or a GUI, and may be refused macOS-protected folders. Services that need a login wait for one; that is #287's second item, a separate change.
  - **FileVault.** It is off on this Mac. With FileVault on, nothing starts until the disk is unlocked.

## The Caddy process

Rig's Caddy runs as its own job, `com.b-relay.rig-caddy.<hash>`, in the same domain as rigd: a system job in `boot` mode, a LaunchAgent in `login` mode, or a detached process in `process` mode. It is never a child of rigd. Its command is `<root>/caddy/bin/caddy run --config <root>/caddy/current/adapted.json`, behind the token guard described under **Token**. Caddy runs the generation's adapted JSON, frozen when Rig validated it, so it never re-reads a Caddyfile, an import or an environment variable afterwards.

- **It outlives rigd.** A rigd restart, crash or upgrade never touches Caddy, and Caddy needs nothing but files on disk to start.
- **`rigd install` owns installation.**
  - When Host config has a `proxy` section, it checks the binary and the token, installs or verifies the job, and has the config applied. Applying goes through `proxy-apply` when a rigd is running, so all publication stays in rigd's one queue, or is done directly before rigd starts.
  - Without a `proxy` section, it removes a Caddy job left from before. Removal ends only once the job is confirmed gone: launchd's `print` exits 113 for a LaunchAgent (as for a system job), and a detached process has exited. A refused or unobservable stop keeps the plist and fails `rigd install` with the job and the command that stops it, so a switch to external routing is never reported done while Rig's Caddy may still serve stale routes (rigd itself still starts, as for every proxy failure).
  - It records the proxy mode (`none`, `external` or `managed`) in `install.json`. A different mode restarts rigd even when its build is unchanged, because rigd chooses its router when it starts.
  - It always keeps `caddy/data`, the certificate storage, and the token.
- **Serving state is never guessed.** An operation may depend on what Caddy serves. A withdrawal, for example, must have taken effect before the upstream is stopped. Rig reads what Caddy runs from `GET /config/` on its admin socket. That equals `caddy adapt` of the generation's main file (checked on 2.10.2), which each generation keeps as `adapted.json`.
  - **Activation is confirmed.** After a reload or restart, Rig reads the config back. A Caddy that answers but does not run the new generation fails the change with `PROXY_ACTIVATION`, and the previous generation is served again.
  - **Every change reconciles first.** Before a route change edits anything, Rig makes Caddy serve the current generation if it does not: a reload, or a restart when the CA differs. A crash between switching `current` and reloading therefore never outlives the next change or rigd's startup.
  - **The route file has to be served too.** A route file ahead of the current generation (a crash between writing it and publishing) is published before any change resolves, even one that adds nothing. A removal never resolves while Caddy may still route to the upstream.
  - **When the socket does not answer,** Rig asks the job manager, and while the job runs it waits up to 10 s for the socket, since at boot launchd shows Caddy running before it listens:
    - **Stopped, confirmed.** In launchd the job is not loaded (`launchctl print` exits 113; its words on any other exit prove nothing) or is loaded with no pid; in `process` mode the recorded process is gone. Caddy reads the current generation when it starts, so the change is complete.
    - **Running but unreachable, or unknown.** The socket may be deleted, refuse permission or hang while HTTPS still serves the old config. The change fails with `PROXY_UNREACHABLE`, the previous generation stays current, and the operation that needed it fails before it touches an upstream.
  - **Doctor reads the same.** Its `proxy-serving` check compares what Caddy runs with the current generation.
- **Process mode.** This mode exists for e2e tests that opt in with `proxy`, high ports and `ca: internal` under an isolated `RIG_ROOT`. Nothing restarts the process there. Existing tests and dashboard sandboxes have no `proxy` section and run no Caddy.
- **Ports.** macOS lets a non-root process bind ports below 1024 only on the wildcard address (checked: `*:444` bound, while `127.0.0.1:444` and the Tailscale address failed with `EACCES`).
  - **Listening on all interfaces.** Rig's Caddy therefore listens on all interfaces for 80 and 443, as b-caddy does. This is a deliberate, narrow exception to the localhost-only rule: the edge must be reachable from the tailnet, and there is no narrower binding without root. Upstreams stay localhost-only.
  - **High ports.** When both ports are 1024 or above (staging, tests), Rig renders `default_bind 127.0.0.1`. A mix of high and low ports is refused.
  - **Busy ports.** Before moving to new ports, Rig checks that they are free or already held by its own Caddy. Otherwise it fails `PROXY_PORT_BUSY`, naming the holder when a non-root `lsof` can see it.
- **The admin API is a Unix socket.** It is `unix/<root>/caddy/admin.sock|0600`, not `localhost:2019`, which the router holds until it is removed and which any local user could reach.

## Binary: a configured Caddy, installed atomically with an automatic way back

`proxy.caddy` names a Caddy executable. `rigd install` copies it into `<root>/caddy/bin/caddy-<sha256 prefix>`, a file that is never modified afterwards, and checks it:

1. `caddy version` is at least 2.10.
2. `caddy list-modules` includes `dns.providers.cloudflare`.
3. `caddy validate` accepts the current generation.

Only then does Rig point the `bin/caddy` symlink at the new file, by renaming a new link over the old one, so the switch is atomic. A check that fails leaves everything as it was and reports `PROXY_BINARY`.

Version 2.10 is the floor because, from 2.10 on, a managed wildcard covers its subdomains by default (checked on 2.10.2 and 2.11.7). 2.11 refuses `auto_https prefer_wildcard`, so Rig never writes it.

- **Activation has a deadline.** Rig restarts Caddy (stop, and launchd starts it again) and waits up to 30 s for the admin socket to answer. The answering process started after the switch, so it runs the new copy. If the new binary passed validation but fails to run, Rig points the symlink back at the last copy that served and restarts again. The failure is reported as `PROXY_BINARY_START` with the new binary's last log lines, the token redacted.
- **Activation is durable.** `bin/state.json` records the last copy that served and the copy switched to but not yet confirmed running, and is written before the switch. An install killed after the switch is picked up by the next one, which starts and confirms the copy, or goes back. A copy that keeps failing is reverted to the last good one, never to another unconfirmed copy. A pending record whose copy never reached the link (an install killed before the switch) is abandoned: it is cleared, and only a pending copy that the link names counts as unconfirmed.
- **Downtime.** A restart costs about one second when Caddy had been running longer than `ThrottleInterval`. Otherwise launchd waits up to the rest of those 10 s before starting it again. A failed upgrade can cost up to about 40 s: the deadline, then a restart of the previous binary.
- **Already in place.** The Host already has a suitable binary: `/usr/local/bin/caddy` is v2.10.2 with `dns.providers.cloudflare` v0.2.4.

## Host config: `proxy` replaces `providers.caddy`

```yaml
proxy:
  caddy: /usr/local/bin/caddy # Caddy with the DNS module; Rig runs its own copy
  ports: { http: 80, https: 443 }
  tls:
    email: clay@b-relay.com # ACME account contact; optional
    ca: letsencrypt # letsencrypt | letsencrypt-staging | internal | an ACME directory URL
    dns: cloudflare # DNS-01 provider; the only one for now
    certificates: wildcard # wildcard | hostname
    resolvers: [1.1.1.1, 1.0.0.1] # where Caddy checks challenge propagation
  routes: # your own hostnames outside any Project, each to a loopback service
    grafana.b-relay.com: 3000 # a port means 127.0.0.1:<port>
    files.b-relay.com: 127.0.0.1:8080 # or 127.0.0.1:<port> or localhost:<port>
daemon:
  start: login # boot | login
```

- **Fields.** Every field is documented in the schema and has the default shown, except `caddy`, which is required.
- **No `proxy` section.** Rig runs no Caddy and writes routes unpublished, as it does today without a Host Caddyfile.
- **Replaced keys.** `extra_config`, `host_caddyfile`, `reload` and `caddyfile` have no successor: no config carries Caddy directives (see **Customization**). The router's `backend_errors` page is built in.
- **Resolvers.** They are pinned because this Mac resolves through Tailscale MagicDNS.

Rig reads the `proxy` settings each time it renders, so `rig proxy reload` applies an edit to them. Changing `caddy` needs `rigd install`.

`providers.caddy` keeps working for one release, so the cutover can be rolled back.

- **Telling the modes apart.** The schema prefaults `providers.caddy`, so Rig decides the mode from the raw YAML: a written `proxy` is managed, a written `providers.caddy` is external, and neither is none.
- **Both written.** `rigd install` refuses and asks for `providers.caddy` to be deleted. A running rigd uses `proxy` and doctor reports the leftover section as ignored. rigd still starts, because it reads Host config at startup.
- **After that release.** `providers.caddy` is ignored and reported, the way `alerts` was retired.

## Generations: crash-safe publication

Caddy never reads a file that Rig is in the middle of changing. Each change builds a complete, self-contained **generation**:

```
<root>/caddy/generations/<id>/Caddyfile            main file; every import names a file of this generation
<root>/caddy/generations/<id>/routes.caddy         copy of the route file
<root>/caddy/generations/<id>/adapted.json         what Caddy runs: the main file, adapted and frozen
<root>/caddy/generations/<id>/generation.json      the CA and binary it was built for, and when
<root>/caddy/current -> generations/<id>           the one switch, renamed into place atomically
```

The rest of the layout:

```
<root>/caddy/data/              certificate storage; kept across reinstalls and uninstalls
<root>/caddy/bin/caddy          symlink to an immutable caddy-<sha> beside it
<root>/caddy/admin.sock         admin API, mode 0600
<root>/caddy/caddy.log          Caddy's own log, rolled by Caddy
<root>/proxy/Caddyfile          Rig's marked route blocks: the source of truth for routes, same path and format
<root>/auth/acme-dns.token      the Cloudflare API token, mode 0600
<root>/caddy/settings-rejected.json  Host config Rig last refused, with why; removed once Host config is accepted
```

Publishing one change goes like this:

1. **Build.** Render a new generation into `generations/<id>.tmp/`.
   - Every value from config or the Rig root (paths, ports, the CA URL, the email, the DNS module, resolvers, hostnames, upstreams) is written through one helper, `caddyValue`: it checks the value against its field's own pattern, refuses `{`, `}`, whitespace, quotes, backslash, `#` and control characters whatever the field, and writes it as one double-quoted token. No value can carry a placeholder, an `{$ENV}` expansion, a directive or a comment, so Caddyfile parsing is no longer a surface config can reach. The route file's hostnames, prefixes and upstreams pass the same check and stay unquoted, since its format is a contract with the external router.
   - The settings are the accepted ones (see **Customization**), recorded whole in `generation.json`.
   - The owner's `proxy.routes` are rendered into the main file by Rig, each as a site with a lone `reverse_proxy` to its loopback upstream, and recorded in `generation.json`: the inventory `rig proxy`, `verify` and doctor use. One of them that names a hostname a Target serves (compared bare: no scheme, no port, lowercase) refuses the generation with `ROUTE_CONFLICT` (see **One owner per hostname** below).
   - Then rename the directory to `generations/<id>/`.
2. **Validate.** Run `caddy adapt` on its main file with Rig's binary, check the result, and only then `caddy validate` it.
   - Adapting provisions nothing. The adapted JSON must hold the admin socket, storage and ports Rig set.
   - Rig adds its own page to every server, as JSON it generates itself, for errors Caddy itself raises: 502, 503 and 504 when an upstream cannot be reached or does not answer in time answer `<status> - <host> is currently down` as plain text, and a withheld path's `respond 503` says the same. A response the app sends passes through unchanged, whatever its status: an app may answer 503 on purpose, as Share does when its free-space probe fails.
   - The result is kept as `adapted.json`, and `caddy validate --config adapted.json` provisions exactly what Caddy will run.
   - If any step fails, the generation is set aside as `.rejected`; nothing else has changed.
3. **Switch.** Rename a new `current` link over the old one.
4. **Activate.** Reload Caddy with the generation's `adapted.json`, or restart it when the issuance policies changed, then confirm from `GET /config/` that it runs `adapted.json`.
   - If that fails, put `current` back and make Caddy serve the previous generation, again confirmed.
   - If Caddy is unreachable, follow the rule under **The Caddy process**.

**One owner per hostname.** A hostname belongs to exactly one owner: one Target's block or one `proxy.routes` entry. The invariant is checked at the single point where the route file and the generation are written, so no publication path can bypass it: apply, a restore (a rollback, or the recovery stop `rig down` runs), rigd's startup republish and `rig proxy reload`. A route file or Host config that would give a hostname two owners is refused with `ROUTE_CONFLICT`, naming both and the way out (`rig down` or `rig destroy` of one Target, or a `proxy.routes` edit and `rig proxy reload`). It is checked on the prospective content before anything is written, so the route file, its `.rig-backup`, a generation and `current` never hold a duplicate. A deploy's preflight builds the whole prospective route file, with its own change applied, and checks it the same way before anything stops, so a deploy blocked by an unrelated duplicate is refused while the old Deployment keeps serving. A change that removes one of two owners publishes; a change that would publish the file with a duplicate still in it is refused, since that would serve the duplicate; a change with nothing of its own to publish (a rollback of a route that never changed, a removal of a route that is not there) succeeds without writing. Rig's Caddy compares hostnames bare (Caddy merges blocks across schemes and ports); the external router, which applies the same check where it writes its route file, compares them as Caddy addresses sites (so `app.test:8443` is another site there). Reservations still protect deploys in flight, but correctness does not depend on them. The external router on main restored a saved block without this check, so a hostname another Target had committed meanwhile could be published twice; the write-point check fixes it there too.

**A block lives no longer than its Target** ([#336](https://github.com/b-relay/rig/issues/336)). A block is keyed by its Target's id, so a block whose Target no state record names is owned by nothing Rig can reach: no `rig down` or `rig destroy` can clear it, and it would refuse its hostnames to every later owner for as long as the Rig root exists. Two rules keep that from happening:

- **Every path that drops a Target record withdraws its block first.** A Preview destroy retires the route before its record goes (as before). `rig forget` now withdraws the route of each of its Targets (working and stable; Previews must be destroyed first), each confirmed as any removal is, before it drops the registration. When a withdrawal cannot be confirmed (`PROXY_UNREACHABLE`, `ROUTE_RELOAD`, `ROUTE_VALIDATE`, a duplicate elsewhere in the file), the forget is refused with that code, the routes already withdrawn are published again, and nothing changes; the hint says to run it again once the proxy answers. Refusing is preferred to leaving an orphan: the Targets are stopped, so a refused forget costs nothing that is served. When the state write fails after the withdrawal, the routes are published again (`FORGET_ROLLBACK` when that fails too; the Targets are stopped and `rig up` or `rig deploy` publishes them again). A crash between the withdrawal and the write leaves a registered, stopped Target without its route, which its next start publishes. Rename and repoint keep Target ids, so they keep their blocks' owners.
- **A block whose Target no record names is withdrawn.** Hosts already holding one (left by a forget from before this rule, a crash, or a lost state file) recover without wiping the root. The router withdraws every block whose key is not a recorded Target id (`Router.withdrawUnowned`), as one change published and confirmed like any other: when rigd starts, before a deploy, `up` or `restart` of a Target with a route, and on `rig proxy reload` (before it applies Host config, so a `proxy.routes` entry may take over the hostname in the same reload; without a `proxy` section the reload only withdraws). Doctor names any that remain (`route-owners`). A sweep that fails is recorded, and a deploy that then meets the orphan is refused with `ROUTE_CONFLICT` naming a route whose Target no longer exists, the sweep's failure, and `rig doctor` and `rig proxy reload` as the way out, rather than a `rig down` of a Target that does not exist. The recorded Target ids are read inside the router's queue, after every change queued before the sweep, and every Target is recorded before its route is published (a deploy persists its candidate first, `up` its planned Target), so a block for a Target being created is never taken for an orphan. Removing a block never adds an owner, and the result passes the same one-owner check, so two owners are never published. With nothing to withdraw, nothing is asked of Caddy.

  Why this rather than letting publication overwrite a block whose owner is unknown: the router would need Target state at its write point, and a conflict would silently take a hostname from a block the router cannot tell apart from a Target recorded a moment later. The sweep keeps the provider free of state (the runtime hands it a reader), runs at named moments, and is visible in doctor and the diagnostic log. An external `providers.caddy.caddyfile` outside the Rig root (by real path, through any symlink) may be shared with another root, such as a `RIG_ROOT` sandbox naming the real root's file, so there the sweep never runs on its own: doctor names the blocks, says another root may own them, and only an explicit `rig proxy reload` withdraws them. Recording which blocks this root published and sweeping only those was rejected: blocks left by forgets before this change were never recorded, so the Hosts that need recovery would not get it.

The route file keeps its role, but in managed mode it is only what Rig renders: every change and republish rebuilds it from the sites parsed out of its owned blocks, each rendered again from validated values with no directive of any config. Nothing of the existing text is kept as text. Whatever lies outside the markers (an external router's `extra_config` that ended a block early, an edit), any other line in a block, and a site whose values fail the check are dropped from what is published and overwritten on disk, and doctor names a file that holds such text (`proxy-route-file`). External mode, kept only as the rollback path, still renders `extra_config`; none of its free text reaches Rig's Caddy. The Router edits its marked blocks, keeping the `.rig-backup` copy and its rollback, and a generation copies it. Rig keeps the current generation, the previous one and three more, and deletes older ones.

**Recovery.** What Caddy serves is read from Caddy, so a crash at any step is recovered by the next change or by rigd's startup, whichever comes first:

- **An unfinished `.tmp` generation.** Nothing points at it, and the next publication deletes it.
- **A route file ahead of `current`.** It is published, with the accepted settings, before any change resolves.
- **A `current` that Caddy does not run** (a crash between steps 3 and 4). Caddy is reloaded, or restarted when its issuance policies differ.

**Why a policy change restarts.** Caddy 2.10 keeps the ACME issuer it already provisioned for a subject across a reload, so a reload alone could leave a name on the old CA. Rig compares the policies Caddy runs with the generation's, each as its sorted subjects and the issuers that serve them (module and CA), and restarts on any change in which CA issues which names, not only when the set of CAs changes.

- **A missing or dangling `current`.** It is rebuilt from the route file and Host config.
- **Serving cannot be confirmed.** Route changes fail, and doctor says why. rigd still starts, and never deletes a working `current`.

The main file of a generation, with the current hostnames:

```caddyfile
# Generated by Rig from Host config. Do not edit: your own hostnames go under proxy.routes in config.yaml.
{
	admin "unix/<root>/caddy/admin.sock|0600"
	persist_config off
	storage file_system "<root>/caddy/data"
	http_port "80"
	https_port "443"
	email "clay@b-relay.com"
	cert_issuer acme "https://acme-v02.api.letsencrypt.org/directory" {
		dns "cloudflare" "{file.<root>/auth/acme-dns.token}"
		resolvers "1.1.1.1" "1.0.0.1"
	}
	log default {
		output file "<root>/caddy/caddy.log" {
			roll_size 10MiB
			roll_keep 5
		}
	}
}

# One certificate per parent of a served hostname. A name below one of these that no site serves is refused.
"*.b-relay.com" "*.melody.b-relay.com" "*.share.b-relay.com" {
	abort
}

import "<root>/caddy/generations/<id>/routes.caddy"

"grafana.b-relay.com" {
	reverse_proxy "127.0.0.1:3000"
}
```

- **Several hostnames per Target.**
  - **Requests.** `RouteRequest` is `{ key, sites: [{ hostname, routes }] }`. A Target's sites share one marked block, so they are published, checkpointed, restored and withdrawn together.
  - **Answers.** `withheld` answers per hostname.
  - **Refusals.** A hostname listed twice is `ROUTE_INVALID`, and one served elsewhere is `ROUTE_CONFLICT`.
  - **Plans.** `plannedSites(plan)` derives the sites. Today that is the one `domain`.
- **Republishing.** The Router gains `republish`. It rebuilds the route file from its owned blocks (see **Generations**) and builds a generation from Host config as it is now. rigd runs it at startup in every mode, and `rig proxy reload` runs it.
- **One queue.** `republish`, `apply`, `remove` and `restore` all share the router's one serialized queue, which is the critical section ADR 0007 gives the route file. Settings come from a reader rather than from values captured when rigd starts.
- **One issuer.** The config names exactly one issuer, so Caddy never falls back to ZeroSSL. `ca: internal` renders `local_certs` and `skip_install_trust` instead, for tests.
- **The token stays out of config.** `{file.…}` stays a placeholder in adapted JSON (checked).
- **No wildcard routes.** The wildcard blocks exist only so Caddy manages those certificates. They `abort`, which closes the connection, and reach no process.

## Customization

No config carries Caddy text. Two review rounds found ways past every check on an owner Caddyfile (quoted and backtick tokens, `{$ENV}` placeholders that expand to an import, snippets, addresses Caddy merges with Rig's), and a third found the same in free-form fields: `proxy.site` directives, and a `tls.ca` URL holding `{$NAME}` that expanded into a global logger. So every value is structured, validated by the schema, and written by Rig through `caddyValue` (see **Generations**), and the owner's need, a hostname outside any Project sent to a service on this Mac, is a structured field:

```yaml
proxy:
  routes:
    grafana.b-relay.com: 3000 # 127.0.0.1:3000
    files.b-relay.com: 127.0.0.1:8080 # or localhost:<port>
```

- **Validated by the schema.** Each key is a lowercase hostname under the same rules as `domain` (no scheme, port, path or wildcard). Each value is a port, or `127.0.0.1:<port>` or `localhost:<port>`. `tls.ca` is a named CA or an `https://` URL of letters, digits and `. - _ ~ % /`, and `tls.email` a plain address: neither may hold a placeholder.
- **Rendered by Rig.** Each route becomes a site with a lone `reverse_proxy` to its upstream. Its certificate follows Rig's policy: the wildcard of its parent, or its own name with `certificates: hostname`.
- **No `proxy.site`.** The directives it added to every Target's block are gone. Their one use here, the router's `backend_errors` page, is built in: Rig's page for errors Caddy itself raises, such as an upstream it cannot reach (see **Generations**). With no config text left, the allowlist that held site lines to a short list of handlers is gone too; `protectedDifferences` still checks that the adapted admin socket, storage and ports are Rig's.
- **One hostname, one owner.** Both inventories are compared as bare lowercase hostnames, since Caddy merges two blocks for one name written with different schemes or ports, and one would take over the other's requests.
  - A route whose hostname a Target serves is refused (`ROUTE_CONFLICT`); nothing changes and the Target keeps serving.
  - A Target, or a Preview created later, asking for one of these hostnames is refused as `ROUTE_CONFLICT`, naming `proxy.routes`.
- **Last accepted settings.** Host config Rig refuses never blocks a Project.
  - `rig proxy reload` and rigd's start publish Host config as it is now. When Rig refuses it (`PROXY_CONFIG_INVALID`, `ROUTE_CONFLICT`, `PROXY_PATH` or `PROXY_TOKEN`), the command fails with the reason, the refusal is recorded in `caddy/settings-rejected.json`, and Caddy keeps the settings it last accepted. A route file ahead of what Caddy serves is still published, with those.
  - Every route change and recovery publishes with the accepted settings, which each generation records whole. A generation that recorded none is no last-good: it is treated as having no accepted generation (Host config is used, as for the first), and there is no migration, since no release made one. An unrelated deploy therefore never fails on a refused Host config (the reproduction: a route colliding with Target A, then a deploy of B; B stays up).
  - `rig proxy`, doctor (`proxy-settings`) and the dashboard show Host config that is not served apart from what is: refused, with the reason, or not applied yet. What they describe as served (ports, CA, certificates, routes) comes from one accepted generation, resolved once per read (doctor's serving check compares Caddy's config with that same generation's `adapted.json`), so a publication that switches `current` meanwhile cannot mix two.
  - A Host config that no longer parses or validates stops rigd from starting, as before; `rig proxy reload` against a running rigd fails with `PROXY_CONFIG`, naming the fields at fault.
- **A deploy checks its route first.** Before it stops the previous Deployment, a deploy asks the router whether the candidate's route could be published (`ROUTE_INVALID`, `ROUTE_CONFLICT`), changing nothing. A route that cannot be published fails the deploy with the previous Deployment still serving. The hostnames it checked, and those the Target's route serves now (the previous Deployment's, which a rollback restores; reserved even when the candidate is route-free), are then reserved, in rigd's memory and inside the publication queue: another deploy's check or route for one of them is refused as `ROUTE_CONFLICT` (so two concurrent deploys of one hostname cannot both stop their previous Deployments), and a `rig proxy reload` that claims one is refused as a hostname a deploy is about to publish. A restoration is held to reservations and the owner's routes as a new route is, so a rollback never takes a hostname another deploy reserved. No route change during the deploy ends the reservation; the deploy releases it when it is decided, on every path: activated (the route file then holds the hostnames), prepared without starting (`--no-up`), failed or rolled back. rigd's restart clears all reservations. (The alternative, refusing any `proxy.routes` hostname a Target's recorded state names, would close the same paths but needs Target state inside the proxy provider; the reservation keeps that knowledge where the deploy already is.)
- **Frozen.** Caddy runs the frozen `adapted.json`, so nothing is read again behind Rig's back.
- **Custom Caddy files left from earlier builds.** `proxy/custom.caddy` and `proxy/custom-global.caddy` are not read. Doctor reports one left on disk (`proxy-custom-file`), with a hint to move its hostnames to `proxy.routes` and delete it.
- **What has no home.** Anything beyond a plain reverse proxy and Rig's down page (a static site, redirects, other error pages) is not served by Rig's Caddy. A need for one becomes a structured option, not Caddy text.

## Token: written by Rig, never echoed

`rig proxy token` reads the token from standard input and writes it to `<root>/auth/acme-dns.token` with mode 0600, atomically. The token is a Cloudflare API token with **Zone:DNS:Edit** and **Zone:Zone:Read** on `b-relay.com` only. The command never asks rigd and never sends the token over the control plane.

- **A malformed token is refused before Caddy sees it.** caddy-dns/cloudflare v0.2.4 quotes a token it rejects in its own error (`API token '%s' appears invalid`), so a pasted newline or stray space would put the token into logs. Rig therefore accepts exactly the forms the plugin's `validCloudflareToken` accepts, after trimming surrounding whitespace:
  - `^[A-Za-z0-9_-]{35,50}$`, a classic token;
  - `^cf(ut|at)_[A-Za-z0-9_-]{32,256}$`, a user or account token.

  Doctor reads the file only to check the same format and its mode. It never shows any part of the token.

- **Caddy never starts on a malformed token.** A token edited by hand would reach the plugin when Caddy starts, and Caddy's startup error goes straight to the job's log, where Rig cannot redact it. So the job runs Caddy through a short `/bin/sh` guard:
  - **The check.** It compares the token file's exact bytes (a trailing newline counts) with those two forms, and refuses to start when they do not match. It says which file to fix, never what is in it.
  - **Binary-safe.** It counts bytes with `wc -c` and deletes the allowed characters with `LC_ALL=C tr -d`, so a NUL, CR or high byte counts as a stray character. Line-based tools such as `grep` are not used, because they stop at a NUL or newline, and BSD `grep` allows no repetition count above 255.
  - **The start.** Otherwise it `exec`s Caddy, so launchd's pid and signals are Caddy's.

  Tested with synthetic tokens.

- **Rig redacts every Caddy output it keeps or shows.** That covers validate, adapt and reload errors, start failures, diagnostics and Activity: the token's value, and anything Caddy quotes after `token`, become `[redacted]`.
- **Limits, honestly.** Caddy runs as clay, and clay can edit its config. Rig serves nothing that could read the token, since no config carries Caddy text, but clay can still edit Rig's own files, and any process running as clay can read the token directly. Mode 0600 keeps out other macOS users and nothing more. That is why b-secret is removed rather than kept.
- **What a leak can do.** A leaked token edits the records of one zone, which is enough to take over its traffic and certificates. Nothing else.
- **The token is required.** Without a readable token Caddy cannot provision, even with stored certificates (checked), so doctor checks it and Rig refuses to render without it.
- **Possible hardening, not built.** ACME challenges could be delegated by CNAME to a separate zone with `dns_challenge_override_domain` (validated). The token could be IP-filtered to the Mac's egress address.

## Certificates: one wildcard per parent

Rig knows every hostname, so there is no on-demand TLS and no ask endpoint. Each hostname is covered by `*.<hostname minus its first label>`, provided that parent has at least two labels.

| Hostnames                                                            | Covered by                                         |
| -------------------------------------------------------------------- | -------------------------------------------------- |
| `rig`, `pantry`, `pantry2`, `vitals`, `design`, `fletcher`, `melody` | `*.b-relay.com`, which the front Caddy holds today |
| `api.melody`                                                         | `*.melody.b-relay.com`                             |
| `private.share`                                                      | `*.share.b-relay.com`                              |

Today's `dev.*` names add one parent each, and the old-style Previews under `*.rig` add one more until they are destroyed.

Under ADR 0010, a Preview's name lands in the first label (`pantry-feat-x-1a2b3c4d.b-relay.com`, `api-feat-x-1a2b3c4d.melody.b-relay.com`), so the Target's wildcard already covers every Preview. A `targets.preview.domain` that puts the Preview name deeper gives every Preview a parent, and so a certificate, of its own. `certificates: hostname` writes no wildcard blocks.

Why one wildcard per parent rather than a certificate per hostname:

- **Rate limits.** A Preview needs no DNS-01 round of its own. Let's Encrypt allows 50 new certificates per registered domain per 7 days, shared with everything else that issues for `b-relay.com`. It also allows only 5 duplicates of one exact set of names per 7 days, counted across accounts, and 5 failed authorizations per name per hour. Renewals are exempt from the 50.
- **Privacy.** Certificate Transparency logs would otherwise publish every branch slug.
- **Speed.** A new parent costs one issuance. DNS propagation can take minutes, so Rig reports a certificate as ready separately from a successful reload.

The `*.b-relay.com` key is already on this Mac today. The DNS token can obtain any certificate for the zone anyway, so the wildcard adds little.

**Changing the CA restarts Caddy.** Caddy keeps its certificate cache across reloads, and CertMagic does not acquire a certificate for a managed name it already has cached, so a reload from staging to production would keep serving the staging certificates. A generation records its CA. When the new one names a different CA than the running one, Rig restarts Caddy instead of reloading it. Storage is kept, so certificates survive reinstalls and do not spend the duplicate limit.

**Readiness is its own check.** `rig proxy verify` checks every served hostname, Rig's and `proxy.routes`', against the local HTTPS port: the one the current generation was accepted with, read from that same generation as the hostnames (`--port` overrides it), never a port from Host config Caddy has not taken. A passed handshake is not repeated while `--wait` retries, but only while the generation and port it was made against hold; either changing asks every hostname again. For each one it does a real TLS handshake with that name and checks the certificate chain against the root store Rig's runtime ships (Mozilla's, which includes Let's Encrypt), its expiry (more than 7 days left) and that the issuer is not a staging CA. It exits non-zero if any name fails, and `--wait <seconds>` retries until the time runs out. `--staging-ok` accepts a staging certificate, which chains to no trusted root, only when its issuer names itself a staging CA and it was issued for that very name. Rig reports what it actually served. It does not infer state from Caddy's log.

## Protocol and commands

The commands come first:

- `rig proxy` prints the state of the Caddy job and its sites with their certificates, as the accepted generation serves them: each Target's paths and each of the owner's `proxy.routes` with its upstream. Host config that is not served follows on its own line, refused with the reason or not applied yet.
- `rig proxy reload` applies the `proxy` section of Host config as it is now, `proxy.routes` included.
- `rig proxy verify` is described above.
- `rig proxy token` writes the token.

Each command supports `--help` and `-h`.

The first three read or act through two control-plane actions:

- **`proxy` (read)** returns:
  - **The job:** state (`running`, `stopped`, `unreachable` or `not-installed`), binary, and the ports and CA of the accepted settings.
  - **Sites:** one per hostname, with `source` `target` (`project`, `target`, `routes`) or `custom` (`upstream`, from `proxy.routes`), and the certificate subject that covers it under the accepted settings.
  - **Pending:** Host config's proxy fields that differ from the accepted settings, with the refusal's code and reason or "not applied yet".
  - **Checks:** the doctor checks below.
- **`proxy-apply` (mutation).** Builds and switches a generation from the route file and the current Host config. `rig proxy reload` and `rigd install` send it.

Nothing on the control plane carries the token.

The doctor checks replace `caddy-proxy`:

| Check               | What it checks                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `proxy-process`     | The job's state, including running but unreachable.                                              |
| `proxy-config`      | The running config matches `current`; otherwise it suggests `rig proxy reload`.                  |
| `proxy-binary`      | The Caddy version and the DNS module.                                                            |
| `proxy-token`       | The token file is present, belongs to you, has mode 0600 and a well-formed token.                |
| `proxy-ports`       | Who holds the HTTP and HTTPS ports.                                                              |
| `proxy-settings`    | Whether Host config's proxy section is what Caddy serves: pending a reload, or refused with why. |
| `proxy-custom-file` | A custom Caddy file an earlier build read is left on disk, ignored.                              |
| `proxy-route-file`  | The route file holds text Rig did not write; it is never published and is rewritten.             |
| `route-owners`      | The route file holds a block whose Target no longer exists (both modes); see **One owner**.      |

Certificate readiness is reported by `rig proxy verify`, not by doctor, because it needs network handshakes.

The dashboard's Proxy page lists every hostname from the `proxy` read, the owner's routes among them, read-only. Adding, editing and removing `proxy.routes` there needs a revision-checked, comment-preserving write to Host config followed by a publish that restores the file when the publish fails; that comes later.

## Existing installs

The first release reads both `providers.caddy` and `proxy`. With `providers.caddy` alone, Rig works exactly as today, and doctor adds a notice.

- **Switching.** Edit Host config, run `rig proxy token`, then run `rigd install`. The route file is reused as it is. `extra_config` has no successor: `import cloudflare` is replaced by Rig's issuer, `import backend_errors` by Rig's down page, and republishing drops both lines from Rig's blocks.
- **During the rollback window.** The route file's blocks no longer carry those imports. The old router still accepts the file, since a block without them is valid, so the emergency rollback works: its sites keep the certificates b-caddy holds and show no `backend_errors` page. The full rollback (step 11) re-renders every block with `extra_config` when rigd starts in external mode.

## Cutover runbook (owner runs; `sudo` only where shown)

This Host's cutover requires boot mode. Do steps 1 to 6 in advance; they do not affect live traffic.

**Prepare**

1. Create the scoped Cloudflare token, then run `pbpaste | rig proxy token`.
2. Review `sudo cat "/Library/Application Support/b-secret/caddy/Caddyfile"` for anything beyond TLS and proxying. A hostname that only proxies to a local port goes under `proxy.routes`; anything else has no home in Rig's Caddy yet and must be raised before the cutover.
3. Back up: `cp -p ~/.rig/config.yaml ~/.rig/config.yaml.pre-0014; cp -Rp ~/.rig/proxy ~/.rig/proxy.pre-0014; cp -p /usr/local/etc/caddy-router.caddyfile /usr/local/etc/caddy-router.caddyfile.pre-0014`.
4. **Stage with the staging CA on high ports.**
   1. Replace `providers.caddy` with `proxy`: `ports: { http: 28080, https: 28443 }`, `tls.ca: letsencrypt-staging`, and the `routes` from step 2.
   2. Set `daemon.start: boot`.
   3. Run `rigd install`, paste the lines it prints, and run `rigd install` again.

   The router keeps serving the live sites, but Rig no longer reloads it. Avoid deploys until the cutover, or reload the router by hand after one.

5. Run `rig proxy verify --port 28443 --staging-ok --wait 600`. It proves the token, DNS-01 and the routes work without spending production limits.
6. **Production certificates before any traffic moves.** Set `tls.ca: letsencrypt` and run `rig proxy reload`, which restarts Caddy because the CA changed. Then run `rig proxy verify --port 28443 --wait 900` until every hostname has a publicly trusted, non-staging certificate. Reboot once (`sudo shutdown -r now`) and check, without logging in, that `rig proxy verify --port 28443` still passes over SSH.

**Cut over (seconds of downtime; restores itself on failure)**

7. **Define the two shell functions** in the terminal you will use, with Rig's Caddy label filled in.
   - Each step runs only if the one before succeeded, and each ends by printing what it did, or exactly which step stopped it.
   - `gone` succeeds only once launchd confirms a job is not loaded (`print` exits 113, "Could not find service"; any other failure is not proof), waiting up to 20 s after a bootout; the bootout's own exit status does not decide.
   - **`rollback`** returns the Host to b-caddy and the router. It needs neither rigd, Rig's Caddy nor the token:
     - It **disables** Rig's Caddy persistently, so a reboot cannot bring it back to fight b-caddy for ports 80 and 443.
     - It confirms Rig's Caddy is gone before enabling and starting b-caddy, and confirms b-caddy runs.
     - It reloads the router, and checks a real handshake on port 443.

   ```sh
   RC=com.b-relay.rig-caddy.d8063e9dcf1ba828; BC=com.b-relay.b-caddy
   # Absent only when launchd says so: print exits 113, "Could not find service". Any other failure is not proof.
   absent() { sudo launchctl print "system/$1" >/dev/null 2>&1; [ $? -eq 113 ]; }
   gone() { absent "$1" && return 0
            sudo launchctl bootout "system/$1"  # its status does not decide: it is non-zero while a stop is in progress
            for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do absent "$1" && return 0; sleep 1; done; return 1; }
   rollback() {
     sudo launchctl disable "system/$RC" && gone "$RC" \
     && sudo launchctl enable "system/$BC" \
     && sudo launchctl bootstrap system "/Library/LaunchDaemons/$BC.plist" \
     && sleep 2 && sudo launchctl print "system/$BC" | grep -q 'state = running' \
     && /usr/local/bin/caddy reload --config /usr/local/etc/caddy-router.caddyfile \
     && curl -sS -o /dev/null --max-time 10 https://pantry.b-relay.com/ \
     && echo "ROLLED BACK: b-caddy and the router serve; Rig's Caddy is disabled." \
     || echo "ROLLBACK INCOMPLETE: run each step of rollback by hand and read its error."
   }
   ```

8. **Cut over.** Set `ports: { http: 80, https: 443 }` in `~/.rig/config.yaml`, then paste the line below. It stops and disables b-caddy, confirmed. It then enables Rig's Caddy (in case an earlier rollback disabled it), has Rig serve on 80 and 443, and checks every hostname. If any step fails, it rolls back.

   ```sh
   sudo launchctl disable "system/$BC" && gone "$BC" \
   && sudo launchctl enable "system/$RC" \
   && { sudo launchctl print "system/$RC" >/dev/null 2>&1 || { absent "$RC" && sudo launchctl bootstrap system "/Library/LaunchDaemons/$RC.plist"; }; } \
   && rig proxy reload && rig proxy verify --wait 60 \
   && echo "CUT OVER: Rig's Caddy serves 80 and 443." \
   || { echo "Cutover failed; rolling back."; rollback; }
   ```

9. From another tailnet device, check pantry, vitals, design, the rig dashboard (including sign-in, since `X-Forwarded-For` now comes straight from Rig's Caddy) and one Preview. Then run `rig doctor`.

**Emergency rollback (needs neither rigd, Rig's Caddy nor the token)**

10. Define the functions from step 7 if this is a new terminal, and run `rollback`. It survives a reboot, because Rig's Caddy stays disabled until step 8's line enables it again.
    - **If the route file itself is suspect.** First run `cp -p ~/.rig/proxy.pre-0014/Caddyfile ~/.rig/proxy/Caddyfile`. The snapshot may name old upstream ports, so prefer the live file.
    - **While Rig's Caddy is disabled.** rigd sees Caddy as stopped and keeps writing routes, so after a deploy, reload the router by hand.
    - **To cut over again,** fix the cause and run step 8 again.
11. **Full rollback.** Restore `~/.rig/config.yaml.pre-0014` and run `rigd install`. It prints the line that removes Rig's Caddy job, which only goes on once the job is confirmed stopped.

**Decommission (after a quiet week)**

12. Run:

    ```sh
    sudo launchctl bootout system/com.b-relay.caddy-router; sudo launchctl bootout system/com.b-relay.caddy-ask; sudo rm /Library/LaunchDaemons/com.b-relay.{b-caddy,caddy-router,caddy-ask}.plist; sudo launchctl enable system/com.b-relay.b-caddy
    ```

    Then remove b-secret and its users, delete `/usr/local/etc/caddy-router.caddyfile*`, and revoke b-secret's token. Only Rig's Caddy remains, and `127.0.0.1:2019` is free.

## Open questions for the owner

1. **Boot start.** Should rigd and its Caddy become system jobs that run as clay? That is one sudo chain at install and one at uninstall, never at upgrades, and this Host's cutover requires it. _Recommendation: yes. Keep `login` as the default until #287's question about Services that need a login is settled._
2. **The syntax for a second hostname on a Target.** The coordinator proposes a per-Service `domain`. The internals are ready for it.

## Prototype and survey evidence (2026-10-10, x86_64 macOS 15.7, nothing global touched)

- **Config.** The generated file validated with Caddy **2.10.2** (installed) and **2.11.7** (the build service's download), including the global-block import, the Unix-socket admin with mode 0600, `cert_issuer acme { dns cloudflare {file.…}; resolvers …; dns_challenge_override_domain … }`. `auto_https prefer_wildcard` is **refused by 2.11.7**.
- **Wildcards.** With an internal issuer, both versions issued **only wildcard certificates**. A name under a wildcard was served the wildcard certificate, an unknown name was closed by `abort`, and a custom site beside a wildcard was served by its own block.
- **Token placeholder.** `{file.…}` stayed a placeholder in adapted JSON. Validation with a fake token passed. With the token file unreadable it failed with `API token '' appears invalid`, showing that the plugin quotes the token value in its error.
- **Reloads.** A bad custom file was refused with its file and line, the old config kept serving, and a good edit reloaded over the socket. A duplicated hostname failed with `ambiguous site definition`. `caddy reload` found the socket from the config. A non-glob import of a missing file fails validation.
- **Ports.** As uid 502, `*:444` bound and `127.0.0.1:444` failed with `EACCES`.
- **Download.** The download API returned an unsigned x86_64 build of v2.11.7 with `caddy-dns/cloudflare` v0.2.4.
- **This Mac.**
  - `com.b-relay.caddy-router` is a system job with `username = clay`, and `launchctl print` shows it as clay. It holds `127.0.0.1:2019`.
  - b-caddy is a non-root system job.
  - MagicDNS is on, and FileVault and the application firewall are off.
  - The rigd LaunchAgent runs `/Users/clay/.rig/bin/rigd`.

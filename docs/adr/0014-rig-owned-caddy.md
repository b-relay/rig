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
- There are no wildcard routes, and Rig manages no DNS records.
- The owner can add routes that are not Rig Projects.
- Sites come up at boot, before anyone logs in, as they do today.

Claims marked as checked were checked with an isolated Caddy on high ports under `/tmp`. The evidence is listed at the end.

The coordinator settled these questions:

- Two custom files, applied explicitly.
- A configured binary that Rig copies and checks; Rig does not download Caddy.
- A connection to an unknown name is closed.
- A scoped token file.
- Boot start is built last, as its own slice, with `login` kept as the default until the owner answers. The owner's answer is expected to be yes, so this Host's cutover requires boot mode.
- `providers.caddy` retires after the rollback window.
- No DNS management.

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
  - `EnvironmentVariables` sets `HOME`, `USER`, `LOGNAME`, a fixed `PATH` and `RIG_ROOT`.
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
     sudo install -d -m 755 -o root -g wheel "/Library/Application Support/Rig" \
     && sudo install -m 644 -o root -g wheel ~/.rig/daemon/launchd/com.b-relay.rig-caddy.d8063e9dcf1ba828.plist "/Library/Application Support/Rig/com.b-relay.rig-caddy.d8063e9dcf1ba828.plist" \
     && echo "<sha256>  /Library/Application Support/Rig/com.b-relay.rig-caddy.d8063e9dcf1ba828.plist" | sudo shasum -a 256 -c - \
     && sudo install -m 644 -o root -g wheel "/Library/Application Support/Rig/com.b-relay.rig-caddy.d8063e9dcf1ba828.plist" /Library/LaunchDaemons/ \
     && sudo launchctl bootstrap system /Library/LaunchDaemons/com.b-relay.rig-caddy.d8063e9dcf1ba828.plist
     ```
  - **What the chain guarantees.** The plist is copied into a directory only root can write, and its hash is checked there, before anything reaches `/Library/LaunchDaemons` or launchd. A source plist changed after rigd printed the line therefore fails the hash, and nothing after the failure runs. Rig never asks the owner to run a script, because a file the user can write, run with sudo, would be a way to gain root.
  - **rigd's line.** It is the same chain. After the hash is verified, and before its bootstrap, it adds `&& { launchctl bootout gui/<uid>/com.b-relay.rigd.<hash> 2>/dev/null; rm -f ~/Library/LaunchAgents/com.b-relay.rigd.<hash>.plist; true; }`. The LaunchAgent is therefore removed only once the system plist is verified. A system job and a LaunchAgent are never both enabled for one root, which is what #287 requires.
  - **Order.** The Caddy line comes first.
  - **Confirming.** The owner runs `rigd install` again to confirm.

- **Going back and uninstalling.** Going back to `login`, or `rigd uninstall` (after its usual checks), prints a `sudo launchctl bootout … && sudo rm …` chain.
- **Without a login.**
  - **Host restart.** rigd's Host session probe reads only the boot, so a "Host restart" means a reboot.
  - **Services.** They run without the login Keychain, `gui/<uid>` or a GUI, and may be refused macOS-protected folders. Services that need a login wait for one; that is #287's second item, a separate change.
  - **FileVault.** It is off on this Mac. With FileVault on, nothing starts until the disk is unlocked.

## The Caddy process

Rig's Caddy runs as its own job, `com.b-relay.rig-caddy.<hash>`, in the same domain as rigd: a system job in `boot` mode, a LaunchAgent in `login` mode, or a detached process in `process` mode. It is never a child of rigd. Its command is `<root>/caddy/bin/caddy run --config <root>/caddy/current/Caddyfile --adapter caddyfile`.

- **It outlives rigd.** A rigd restart, crash or upgrade never touches Caddy, and Caddy needs nothing but files on disk to start.
- **`rigd install` owns installation.**
  - When Host config has a `proxy` section, it checks the binary and the token, installs or verifies the job, and has the config applied. Applying goes through `proxy-apply` when a rigd is running, so all publication stays in rigd's one queue, or is done directly before rigd starts.
  - Without a `proxy` section, it removes a Caddy job left from before.
  - It records the proxy mode (`none`, `external` or `managed`) in `install.json`. A different mode restarts rigd even when its build is unchanged, because rigd chooses its router when it starts.
  - It always keeps `caddy/data`, the certificate storage, and the custom files and the token.
- **Serving state is never guessed.** Every publication ends by reloading Caddy, and an operation may depend on that reload. A withdrawal, for example, must have taken effect before the upstream is stopped. When the reload cannot reach the admin socket, Rig asks the job manager what state Caddy is in:
  - **Stopped, confirmed.** In launchd the job is not loaded or has no pid; in `process` mode the recorded process is gone. Then the change is complete, because Caddy reads the current generation when it starts.
  - **Running but unreachable, or unknown.** The socket may be deleted, refuse permission or hang while HTTPS still serves the old config. Then the publication fails with `PROXY_UNREACHABLE`, the previous generation stays current, and the operation that needed the change fails before it touches an upstream.
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

- **Activation has a deadline.** Rig restarts Caddy (stop, and launchd starts it again) and waits up to 30 s for the admin socket to answer with the current generation loaded. If the new binary passed validation but fails to run, Rig points the symlink back at the previous file and restarts again. The failure is reported as `PROXY_BINARY_START` with the new binary's last log lines, with the token redacted.
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
  site: [import backend_errors] # added to every Rig site block; may use snippets from custom.caddy
daemon:
  start: login # boot | login
```

- **Fields.** Every field is documented in the schema and has the default shown, except `caddy`, which is required.
- **No `proxy` section.** Rig runs no Caddy and writes routes unpublished, as it does today without a Host Caddyfile.
- **Replaced keys.** `site` replaces `extra_config`. `host_caddyfile`, `reload` and `caddyfile` have no successor.
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
<root>/caddy/generations/<id>/custom.caddy         accepted copy of proxy/custom.caddy
<root>/caddy/generations/<id>/custom-global.caddy  accepted copy of proxy/custom-global.caddy
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
<root>/proxy/custom.caddy       the owner's sites and snippets; Rig never rewrites it
<root>/proxy/custom-global.caddy the owner's global options; Rig never rewrites it
<root>/auth/acme-dns.token      the Cloudflare API token, mode 0600
```

Publishing one change goes like this:

1. Render a new generation into `generations/<id>.tmp/` and rename it to `generations/<id>/`.
2. Run `caddy validate` on its main file with Rig's binary. If it fails, delete the generation; nothing else has changed.
3. Rename a new `current` link over the old one.
4. Reload Caddy with the generation's main file. If the reload fails, put `current` back and reload the previous generation. If Caddy is unreachable, follow the rule under **The Caddy process**.

The route file keeps its role. The Router edits its marked blocks, keeping the `.rig-backup` copy and its rollback, and a generation copies it. Rig keeps the current generation, the previous one and three more, and deletes older ones.

**Recovery.** A crash can leave an unfinished `.tmp` generation, which nothing points at and the next publication deletes. It can also leave a route file that is newer than `current`. At startup rigd builds a fresh generation from the route file and the current generation's custom copies, and switches to it. A missing or dangling `current` is rebuilt the same way. If no generation validates, rigd starts and doctor reports the problem; it never deletes a working `current`.

The main file of a generation, with the current hostnames:

```caddyfile
# Generated by Rig from Host config. Do not edit: your sites go in ~/.rig/proxy/custom.caddy.
{
	admin "unix/<root>/caddy/admin.sock|0600"
	persist_config off
	storage file_system <root>/caddy/data
	http_port 80
	https_port 443
	email clay@b-relay.com
	cert_issuer acme https://acme-v02.api.letsencrypt.org/directory {
		dns cloudflare {file.<root>/auth/acme-dns.token}
		resolvers 1.1.1.1 1.0.0.1
	}
	log default {
		output file <root>/caddy/caddy.log {
			roll_size 10MiB
			roll_keep 5
		}
	}
	import <root>/caddy/generations/<id>/custom-global.caddy
}
import <root>/caddy/generations/<id>/custom.caddy

# One certificate per parent of a served hostname. A name below one of these that no site serves is refused.
*.b-relay.com, *.melody.b-relay.com, *.share.b-relay.com {
	abort
}

import <root>/caddy/generations/<id>/routes.caddy
```

- **Several hostnames per Target.**
  - **Requests.** `RouteRequest` is `{ key, sites: [{ hostname, routes }] }`. A Target's sites share one marked block, so they are published, checkpointed, restored and withdrawn together.
  - **Answers.** `withheld` answers per hostname.
  - **Refusals.** A hostname listed twice is `ROUTE_INVALID`, and one served elsewhere is `ROUTE_CONFLICT`.
  - **Plans.** `plannedSites(plan)` derives the sites. Today that is the one `domain`.
- **Republishing.** The Router gains `republish`. It rewrites every owned block with the current `site` lines and builds a generation from the current settings. rigd runs it at startup in every mode, so a `site` edit needs no redeploy. A rollback that restores `providers.caddy` gets its `extra_config` back the same way.
- **One queue.** `republish`, `apply`, `remove`, `restore` and custom applies all share the router's one serialized queue, which is the critical section ADR 0007 gives the route file. Settings come from a reader rather than from values captured when rigd starts.
- **One issuer.** The config names exactly one issuer, so Caddy never falls back to ZeroSSL. `ca: internal` renders `local_certs` and `skip_install_trust` instead, for tests.
- **The token stays out of config.** `{file.…}` stays a placeholder in adapted JSON (checked).
- **No wildcard routes.** The wildcard blocks exist only so Caddy manages those certificates. They `abort`, which closes the connection, and reach no process.

## Customization

The owner writes sites and snippets in `proxy/custom.caddy`, and global options in `proxy/custom-global.caddy`. Rig creates both files empty, each with a header comment, and never rewrites them. Caddy loads only the copies in the current generation.

- **Applied explicitly.** `rig proxy reload` builds a generation with the custom files as they are on disk.
  - If it validates and reloads, those copies become the accepted ones.
  - If it does not, nothing switches, Rig's routes keep serving, and the command fails with `PROXY_CUSTOM_INVALID`. The error carries Caddy's message, which names the file and line (checked). A custom site that repeats a Rig hostname fails as `ambiguous site definition`.
- **Each failure has one cause.** A route change always builds against the accepted custom copies, so its failure is a route problem. A custom apply changes only the custom files, so its failure is a custom problem.
  - A new Rig route whose hostname an accepted custom site serves is refused as `ROUTE_CONFLICT`, naming `custom.caddy`.
  - Rig leaves out its own wildcard block for any parent whose wildcard the custom files already serve.
- **Rig's own global options are protected.** A candidate whose adapted `admin`, `storage` or listener ports differ from what Rig rendered is refused.
- **Pending edits are visible.** While a custom file differs from its accepted copy, `rig proxy` and `rig doctor` report it as pending, or as rejected with the last error.

## Token: written by Rig, never echoed

`rig proxy token` reads the token from standard input and writes it to `<root>/auth/acme-dns.token` with mode 0600, atomically. The token is a Cloudflare API token with **Zone:DNS:Edit** and **Zone:Zone:Read** on `b-relay.com` only. The command never asks rigd and never sends the token over the control plane.

- **A malformed token is refused before Caddy sees it.** The command trims surrounding whitespace and accepts only `[A-Za-z0-9_-]`, 20 to 512 characters long. caddy-dns/cloudflare v0.2.4 quotes a token it rejects in its own error, so a pasted newline or stray space would otherwise put the token into logs. Doctor reads the file only to check the same format and its mode. It never shows any part of the token.
- **Rig redacts every Caddy output it keeps or shows.** That covers validate and reload errors, start failures, diagnostics and Activity: the token's value, and anything Caddy quotes after `token`, become `[redacted]`. This is tested with synthetic tokens, including malformed ones.
- **Limits, honestly.** Caddy runs as clay, and clay can edit its config. A custom `respond {file.…}` or `file_server` could serve the token, and any process running as clay can read the file directly. Mode 0600 keeps out other macOS users and nothing more. That is why b-secret is removed rather than kept.
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

**Readiness is its own check.** `rig proxy verify` checks every served hostname, Rig's and the custom files', against the local HTTPS port. For each one it does a real TLS handshake with that name and checks the certificate chain against the system's trust store, its expiry (more than 7 days left) and that the issuer is not a staging CA. It exits non-zero if any name fails, and `--wait <seconds>` retries until the time runs out. Rig reports what it actually served. It does not infer state from Caddy's log.

## Protocol and commands

The commands come first:

- `rig proxy` prints the state of the Caddy job, its sites with their certificates, and whether each custom file is applied.
- `rig proxy reload` applies the custom files and `proxy` settings.
- `rig proxy verify` is described above.
- `rig proxy token` writes the token.

Each command supports `--help` and `-h`.

The first three read or act through two control-plane actions:

- **`proxy` (read)** returns:
  - **The job:** state (`running`, `stopped`, `unreachable` or `not-installed`), launchd domain, binary version and ports.
  - **Sites:** one per hostname, with `source` `target` (`project`, `target`, `routes`) or `custom` (`line`, upstreams from `caddy adapt`), and the certificate subject that covers it.
  - **Custom files:** each file's state.
  - **Checks:** the doctor checks below.
- **`proxy-apply` (mutation).** Builds and switches a generation from the files on disk. `rig proxy reload` and `rigd install` send it.

Nothing on the control plane carries the token.

The doctor checks replace `caddy-proxy`:

| Check           | What it checks                                                                    |
| --------------- | --------------------------------------------------------------------------------- |
| `proxy-process` | The job's state, including running but unreachable.                               |
| `proxy-config`  | The running config matches `current`; otherwise it suggests `rig proxy reload`.   |
| `proxy-binary`  | The Caddy version and the DNS module.                                             |
| `proxy-token`   | The token file is present, belongs to you, has mode 0600 and a well-formed token. |
| `proxy-ports`   | Who holds the HTTP and HTTPS ports.                                               |
| `proxy-custom`  | Whether each custom file is applied, pending or rejected.                         |

Certificate readiness is reported by `rig proxy verify`, not by doctor, because it needs network handshakes.

Editing the custom files from the dashboard (`proxy-custom` and `proxy-custom-edit`) comes after the CLI and the tested rollback. It needs a warning: `custom.caddy` can expose files.

## Existing installs

The first release reads both `providers.caddy` and `proxy`. With `providers.caddy` alone, Rig works exactly as today, and doctor adds a notice.

- **Switching.** Edit Host config, run `rig proxy token`, then run `rigd install`. The route file is reused as it is: `extra_config` moves to `site`, and its snippets (`backend_errors`) move to `custom.caddy`.
- **During the rollback window.** Keep `import cloudflare` in `site`, and define `(cloudflare) {}` in `custom.caddy`. The route file then stays byte for byte something the old router accepts, which is what the emergency rollback relies on.

## Cutover runbook (owner runs; `sudo` only where shown)

This Host's cutover requires boot mode. Do steps 1 to 6 in advance; they do not affect live traffic.

**Prepare**

1. Create the scoped Cloudflare token, then run `pbpaste | rig proxy token`.
2. Review `sudo cat "/Library/Application Support/b-secret/caddy/Caddyfile"` for anything beyond TLS and proxying, and move what should stay into `~/.rig/proxy/custom.caddy`.
3. Back up: `cp -p ~/.rig/config.yaml ~/.rig/config.yaml.pre-0014; cp -Rp ~/.rig/proxy ~/.rig/proxy.pre-0014; cp -p /usr/local/etc/caddy-router.caddyfile /usr/local/etc/caddy-router.caddyfile.pre-0014`.
4. **Stage with the staging CA on high ports.**
   1. Replace `providers.caddy` with `proxy`: `ports: { http: 28080, https: 28443 }`, `tls.ca: letsencrypt-staging`, `site: [import cloudflare, import backend_errors]`.
   2. Set `daemon.start: boot`.
   3. Put `(cloudflare) {}` and the router's `(backend_errors)` into `custom.caddy`.
   4. Run `rigd install`, paste the lines it prints, and run `rigd install` again.

   The router keeps serving the live sites, but Rig no longer reloads it. Avoid deploys until the cutover, or reload the router by hand after one.

5. Run `rig proxy verify --port 28443 --staging-ok --wait 600`. It proves the token, DNS-01 and the routes work without spending production limits.
6. **Production certificates before any traffic moves.** Set `tls.ca: letsencrypt` and run `rig proxy reload`, which restarts Caddy because the CA changed. Then run `rig proxy verify --port 28443 --wait 900` until every hostname has a publicly trusted, non-staging certificate. Reboot once (`sudo shutdown -r now`) and check, without logging in, that `rig proxy verify --port 28443` still passes over SSH.

**Cut over (seconds of downtime; restores itself on failure)**

7. Set `ports: { http: 80, https: 443 }` in `~/.rig/config.yaml`, then paste:

   ```sh
   sudo launchctl bootout system/com.b-relay.b-caddy && sudo launchctl disable system/com.b-relay.b-caddy \
   && rig proxy reload && rig proxy verify --wait 30 \
   || { sudo launchctl bootout system/com.b-relay.rig-caddy.d8063e9dcf1ba828; \
        sudo launchctl enable system/com.b-relay.b-caddy; \
        sudo launchctl bootstrap system /Library/LaunchDaemons/com.b-relay.b-caddy.plist; \
        /usr/local/bin/caddy reload --config /usr/local/etc/caddy-router.caddyfile; \
        echo "Cutover failed and was rolled back"; }
   ```

8. From another tailnet device, check pantry, vitals, design, the rig dashboard (including sign-in, since `X-Forwarded-For` now comes straight from Rig's Caddy) and one Preview. Then run `rig doctor`.

**Emergency rollback (needs neither rigd, Rig's Caddy nor the token)**

9. Run the block after `||` in step 7. It stops Rig's Caddy with launchd, re-enables and starts b-caddy, and reloads the router.
   - **If the route file itself is suspect.** First run `cp -p ~/.rig/proxy.pre-0014/Caddyfile ~/.rig/proxy/Caddyfile`. The snapshot may name old upstream ports, so prefer the live file.
   - **While Rig's Caddy job is booted out.** rigd sees Caddy as stopped and keeps writing routes, so after a deploy, reload the router by hand.
10. **Full rollback.** Restore `~/.rig/config.yaml.pre-0014` and run `rigd install`. It prints the chain that removes Rig's Caddy job.

**Decommission (after a quiet week)**

11. Run:

    ```sh
    sudo launchctl bootout system/com.b-relay.caddy-router; sudo launchctl bootout system/com.b-relay.caddy-ask; sudo rm /Library/LaunchDaemons/com.b-relay.{b-caddy,caddy-router,caddy-ask}.plist; sudo launchctl enable system/com.b-relay.b-caddy
    ```

    Then remove b-secret and its users, delete `/usr/local/etc/caddy-router.caddyfile*`, and revoke b-secret's token. Only Rig's Caddy remains, and `127.0.0.1:2019` is free.

12. Drop `import cloudflare` from `site` and `(cloudflare)` from `custom.caddy`, then run `rig proxy reload`.

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

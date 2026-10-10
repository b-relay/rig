---
status: proposed
---

# Rig runs the Host's one Caddy and terminates TLS

## Today

Two Caddy processes serve every Rig hostname, and both are system LaunchDaemons that start at boot.

The **front Caddy** (`com.b-relay.b-caddy`, user `b-caddy`) is started by the b-secret broker, which injects the Cloudflare token. It listens on `*:80` and `*:443`. It holds a DNS-01 wildcard certificate for `*.b-relay.com` and gets on-demand DNS-01 certificates for deeper names (`api.melody`, `private.share`), which an "ask" service (`com.b-relay.caddy-ask`) approves against the router's Caddyfile. It is Caddy v2.10.2 with caddy-dns/cloudflare, byte-identical to `/usr/local/bin/caddy`.

The front Caddy proxies to the **router Caddy** (`com.b-relay.caddy-router`, user clay). The router listens on `127.0.0.1:18080/18443` with `tls internal` and serves its admin API on `127.0.0.1:2019`. It imports Rig's route file `~/.rig/proxy/Caddyfile`.

Rig itself only edits marked blocks in that route file and runs a reload command from `providers.caddy`. It does not own the processes, ports, certificates, or most of the configuration. When something breaks, `rig doctor` can only say whether the route file is imported.

## Decision

Rig runs **one Caddy**. That Caddy terminates TLS with Let's Encrypt certificates (ACME DNS-01 through Cloudflare, since the Host's addresses are private Tailscale addresses) and routes every Rig hostname. This is the owner's Option A: Rig owns Caddy the way Dokploy owns Traefik.

- The front Caddy, the router, and the ask service all retire, so b-secret and its users can be removed (by the owner, outside Rig).
- The router's own sites (code, core, dev.core, dev.pantry) are deleted, not migrated.
- There are no wildcard routes.
- The owner can add routes that are not Rig Projects.
- Sites come up at boot, before anyone logs in, as they do today.

Every claim marked as checked below was checked with an isolated Caddy on `127.0.0.1` high ports under `/tmp`. The evidence is at the end.

## Boot start: rigd and its Caddy as system jobs that run as the user

This section stands alone. It implements [#287](https://github.com/b-relay/rig/issues/287) for rigd as well as for Caddy, and can ship with the proxy change or before it.

Today `rigd install` loads rigd as a LaunchAgent in `gui/<uid>`, which exists only while the user is logged in at the console. A boot-started Caddy proxying to a rigd that waits for a login would serve errors until someone logs in. So rigd and its Caddy both become **system jobs that run as the user**.

- **Selecting the mode.** Host config gains `daemon.start: boot | login`. `login` is today's LaunchAgent and stays the default until the owner decides otherwise (open question 5). `boot` installs system jobs. A rigd with `RIG_ROOT` set keeps running as a detached process (`process` mode) and ignores this setting. `install.json`'s `mode` gains `system`.
- **Plist shape.** Rig writes the same shape for both jobs, `com.b-relay.rigd.<hash>` and `com.b-relay.rig-caddy.<hash>`, where `<hash>` is the root hash used today:

  ```xml
  <key>Label</key><string>com.b-relay.rig-caddy.d8063e9dcf1ba828</string>
  <key>UserName</key><string>clay</string>
  <key>GroupName</key><string>staff</string>
  <key>ProgramArguments</key><array>
    <string>/Users/clay/.rig/caddy/bin/caddy</string><string>run</string>
    <string>--config</string><string>/Users/clay/.rig/caddy/Caddyfile</string>
    <string>--adapter</string><string>caddyfile</string></array>
  <key>WorkingDirectory</key><string>/Users/clay/.rig</string>
  <key>EnvironmentVariables</key><dict><!-- HOME, USER, LOGNAME, a fixed PATH, RIG_ROOT --></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>/Users/clay/.rig/caddy/launchd.log</string>
  <key>StandardErrorPath</key><string>/Users/clay/.rig/caddy/launchd.log</string>
  ```

  For rigd, `ProgramArguments` is `<root>/bin/rigd`, the stable path used today, and the log is `daemon/startup.log`. Rig never writes a plist without `UserName`, so no Rig job runs as root. The existing `com.b-relay.caddy-router` is already a system job running Caddy as clay, which is the same shape.

- **Upgrades never need sudo.**
  - **Programs stay at stable paths.** `ProgramArguments` always names the same stable paths, so a Rig or Caddy upgrade replaces the files behind them and leaves the plist unchanged.
  - **launchd restarts what exits.** For the system domain, `launchctl kickstart` needs root, so Rig restarts a job by making its process exit and letting the unconditional `KeepAlive` start the new binary. For Caddy, that is `caddy stop` over its admin socket, which costs about one second of downtime. rigd drains and exits as it does on shutdown: Services detach and keep running, and the new rigd adopts them (ADR 0007).
  - **Status needs no sudo.** `launchctl print system/<label>` works as the user (checked), so `rigd status` and `rig doctor` can read job state without sudo.
- **Sudo once, for the plist only.** `rigd install` runs as the user. It renders the plists it wants into `<root>/daemon/launchd/` and compares them with what is in `/Library/LaunchDaemons` (readable by all). When they match and the jobs are loaded, nothing else is needed. Otherwise it stops with `DAEMON_SYSTEM_INSTALL` and prints the exact commands to paste:

  ```sh
  launchctl bootout gui/502/com.b-relay.rigd.d8063e9dcf1ba828; rm ~/Library/LaunchAgents/com.b-relay.rigd.d8063e9dcf1ba828.plist
  sudo install -m 644 -o root -g wheel ~/.rig/daemon/launchd/com.b-relay.rigd.d8063e9dcf1ba828.plist /Library/LaunchDaemons/
  sudo shasum -a 256 -c <<< "<sha256>  /Library/LaunchDaemons/com.b-relay.rigd.d8063e9dcf1ba828.plist"
  sudo launchctl bootstrap system /Library/LaunchDaemons/com.b-relay.rigd.d8063e9dcf1ba828.plist
  # (the same three sudo lines for com.b-relay.rig-caddy.d8063e9dcf1ba828, listed first when Caddy is managed)
  ```

  The owner then runs `rigd install` again, which verifies both jobs. Rig never asks the owner to run a script, because a file the user can write, run by sudo, would be a way to gain root. The plist is checked by its hash after it is root-owned in place, so a plist changed after rigd printed the commands is not loaded. The Caddy job is always bootstrapped before rigd.

- **Moving off the LaunchAgent.** The printed commands boot out the old LaunchAgent and delete its plist first. That is a normal rigd shutdown: Services keep running, and the system rigd adopts them a moment later. A system job and a LaunchAgent are therefore never both enabled for one root, which is #287's acceptance criterion. Going back to `login` prints the reverse: `sudo launchctl bootout` and `sudo rm` for the system plists. `rigd install` then loads the LaunchAgent itself.
- **Uninstall.** `rigd uninstall` runs its usual checks (no running Targets, no unresolved recovery) and then prints the `bootout` and `rm` commands for the system jobs. Running it again confirms they are gone.
- **What changes without a login.**
  - **Host restart means a boot.** rigd's Host session probe reads only the boot, as in `process` mode, so "Host restart" means a reboot and stable Targets start at boot.
  - **Services run without a login session.** They have no login Keychain, no `gui/<uid>` domain, and no GUI. A daemon may also be refused macOS-protected folders (Desktop, Documents, Downloads, iCloud Drive). Projects under `~/Projects` are unaffected. Services that need a login session must wait for one, which is #287's second item and a separate change.
  - **FileVault.** It is off on this Mac, so an unattended reboot comes straight back. With FileVault on, nothing starts until the disk is unlocked at the pre-boot screen.

## The Caddy process

Rig's Caddy runs as its own launchd job, `com.b-relay.rig-caddy.<hash>`, in the same domain as rigd: a system job in `boot` mode, a LaunchAgent in `login` mode, and a detached process in `process` mode. It is never a child of rigd.

- **It outlives rigd.** A rigd restart, crash, or upgrade never touches the Caddy job, so serving continues. Caddy reads only files on disk, so it also starts without rigd.
- **`rigd install` owns installation.**
  - **What it does.** When Host config has a `proxy` section, it checks the binary and the token (below), installs or verifies the job (with the sudo step above in `boot` mode), and makes sure the config is applied. If no rigd is running, it renders and validates the files itself before starting anything. If a rigd is running, it sends `proxy-apply`, so every render and reload goes through rigd's one serialized path. It never writes the files beside rigd.
  - **Without a `proxy` section.** It removes a Caddy job left by an earlier install, itself in `login` and `process` mode or by printed commands in `boot` mode. Certificates, custom files, and the token stay.
- **Mode switches.** Today `rigd install` reports `unchanged` and returns when the same build is serving. From now on it reconciles the Caddy job even then. It also records the proxy mode (none, external, or managed) in `install.json`, and restarts rigd when Host config names a different mode from the one the running rigd started with. rigd chooses its router once, as it starts.
- **rigd never starts or stops Caddy at runtime.** It renders, validates, and reloads. If the job is stopped or its socket does not answer, as at boot while both jobs start, a change is **written but not reloaded**. That is not a failure, because Caddy loads the files on disk when it starts, and meanwhile nothing serves an old upstream. `rig doctor` reports a job that stays missing or stopped.
- **Process mode.** This mode exists for e2e tests that opt in with `proxy`, high ports, and `ca: internal` under an isolated `RIG_ROOT`. The Caddy is recorded with a process identity and stopped by `rigd uninstall`. Nothing restarts it after a crash. Existing tests and dashboard sandboxes have no `proxy` section and run no Caddy, as today.
- **Ports.** macOS lets a non-root process bind ports below 1024 only on the wildcard address.
  - **Checked here.** As uid 502, `*:444` bound, while `127.0.0.1:444` and `100.85.72.39:444` failed with `EACCES`. b-caddy, a non-root system job, already holds `*:443`.
  - **Listening everywhere.** Rig's Caddy therefore listens on all interfaces for 80 and 443, as b-caddy does today. This is a deliberate, narrow exception to the rule that Rig binds only localhost: the Host's HTTPS edge must be reachable from the tailnet, and macOS allows no narrower binding without root. Upstreams stay localhost-only, as the router already enforces.
  - **High ports stay local.** When both configured ports are 1024 or above (staging, tests), Rig renders `default_bind 127.0.0.1`. A mix of a privileged and an unprivileged port is refused.
  - **Busy ports.** Before moving onto new ports, Rig checks that they are free or already held by its own Caddy. Otherwise it fails `PROXY_PORT_BUSY`, naming the holder when a non-root `lsof` can see it. It cannot see `b-caddy`'s processes, so for those it names only the port.
- **Admin API on a Unix socket.** The admin endpoint is `unix/<root>/caddy/admin.sock|0600`, not `localhost:2019`. That address is still taken by the router until it is decommissioned, and any local user could reach it.

## Binary: a configured Caddy, copied into the Rig root and checked

`proxy.caddy` names a Caddy executable. `rigd install` copies it to `<root>/caddy/bin/caddy` (keeping the old copy as `caddy.previous`) when its sha256 differs, and the job always runs that copy. So a `brew upgrade`, or a replacement of `/usr/local/bin/caddy`, never changes the running proxy without notice. Before switching, Rig checks the new copy:

1. `caddy version` is at least 2.10.
2. `caddy list-modules` includes `dns.providers.cloudflare`.
3. `caddy validate` accepts the current rendered config.

A check that fails leaves the old copy in place and fails `PROXY_BINARY` with what is missing. Version 2.10 is the floor because from 2.10 on, a managed wildcard certificate covers its subdomains by default (checked on 2.10.2 and 2.11.7). 2.11 refuses `auto_https prefer_wildcard`, which 2.9 needed, so Rig never writes it.

The Host already has a suitable binary: `/usr/local/bin/caddy` is v2.10.2, x86_64, with `dns.providers.cloudflare` v0.2.4. Upgrading means pointing `proxy.caddy` at a newer binary and running `rigd install`. Getting one is documented, not automated (open question 2): `curl -o caddy 'https://caddyserver.com/api/download?os=darwin&arch=amd64&p=github.com/caddy-dns/cloudflare'`.

## Host config: `proxy` replaces `providers.caddy`

```yaml
proxy:
  caddy: /usr/local/bin/caddy # Caddy with the DNS module; Rig runs its own copy of it
  ports: { http: 80, https: 443 }
  tls:
    email: clay@b-relay.com # ACME account contact; optional
    ca: letsencrypt # letsencrypt | letsencrypt-staging | internal | an ACME directory URL
    dns: cloudflare # DNS-01 provider; the only one supported for now
    certificates: wildcard # wildcard | hostname (see Certificates)
    resolvers: [1.1.1.1, 1.0.0.1] # where Caddy checks challenge propagation
  site: [import backend_errors] # directives added to every Rig site block; may use snippets from custom.caddy
daemon:
  start: boot # boot | login (see Boot start)
```

- **Fields and defaults.** Every field is documented in the schema and has the default shown, except `caddy`, which is required, and `daemon.start`, whose default is `login`. If `proxy` is absent, Rig runs no Caddy and writes routes to the route file unpublished, which is today's default without a Host Caddyfile.
- **What replaces the old keys.** `site` replaces `extra_config`. `host_caddyfile`, `reload`, and `caddyfile` have no successor: Rig owns the main file, reloads Caddy itself, and keeps the route file at `<root>/proxy/Caddyfile`.
- **When edits take effect.** The `proxy` settings are read each time Rig renders, so `rig proxy reload` applies an edit to them without restarting rigd. Changing `caddy` needs `rigd install`.
- **Resolvers.** They are pinned because this Mac resolves through Tailscale MagicDNS, which should not decide whether a challenge record has propagated.

`providers.caddy` (external mode) keeps working for one release, so the cutover can be rolled back. The schema prefaults `providers.caddy`, so parsed config always has one. Rig therefore decides the mode from the raw YAML: a written `proxy` means managed, a written `providers.caddy` means external, and neither means none. If both are written, `rigd install` refuses with a hint to delete `providers.caddy`, while a running rigd uses `proxy` and `rig doctor` reports `providers.caddy` as ignored. rigd does not refuse to start over this, because it reads Host config as it starts. After that release, `providers.caddy` is ignored and reported, the way `alerts` was retired.

## Files, routes, and the generated Caddyfile

```
<root>/caddy/Caddyfile                    generated main file (never edit)
<root>/caddy/accepted/custom.caddy        last accepted copy of proxy/custom.caddy
<root>/caddy/accepted/custom-global.caddy last accepted copy of proxy/custom-global.caddy
<root>/caddy/data/                        Caddy storage: ACME account, certificates, locks
<root>/caddy/bin/caddy                    Rig's copy of the binary (+ caddy.previous)
<root>/caddy/admin.sock                   admin API, mode 0600
<root>/caddy/caddy.log                    Caddy's log (rolled by Caddy)
<root>/proxy/Caddyfile                    Rig's marked route blocks, same path and marker format
<root>/proxy/custom.caddy                 owner's sites and snippets; Rig never rewrites it
<root>/proxy/custom-global.caddy          owner's global options; Rig never rewrites it
<root>/auth/acme-dns.token                Cloudflare API token, mode 0600
```

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
	import <root>/caddy/accepted/custom-global.caddy
}
import <root>/caddy/accepted/custom.caddy

# One certificate per parent of a served hostname. A name below one of these that no site serves is refused.
*.b-relay.com, *.melody.b-relay.com, *.share.b-relay.com {
	abort
}

import <root>/proxy/Caddyfile
```

- **More than one hostname per Target.** Melody needs `melody.b-relay.com` (web) and `api.melody.b-relay.com` (api) on one Target, so routing no longer assumes one hostname per Target.
  - **The request carries every site.** `RouteRequest` becomes `{ key, sites: [{ hostname, routes }] }`. The marked block keyed by the Target's id holds one Caddy site block per hostname, so all of a Target's hostnames are published, checkpointed, restored, and withdrawn together.
  - **Per-hostname answers.** `withheld` returns `{ hostname, prefix }` pairs. `ROUTE_CONFLICT` is decided per hostname.
  - **Plans.** The runtime plan's hostname-with-routes becomes a list, and a plan recorded with one hostname reads as a list of one.
  - **Config syntax is open.** How rig.yaml spells a second hostname is a separate decision, and nothing here fixes it.
- **The route file keeps its path and marker format,** and so does its rollback on a failed reload. Each site still ends with the `site` lines.
- **The `Router` contract grows.** It gains `republish`, which re-renders every owned block with the current `site` lines and the main file with the current `proxy` settings, and the custom-file operations below. rigd runs `republish` at startup, in every mode, so a `site` edit needs no redeploy. A rollback that restores `providers.caddy` gets its `extra_config` lines back the same way. All of these, and `apply`, `remove`, and `restore`, share the router's one serialized queue, the critical section ADR 0007 gives the route file. Settings come from a reader, not from values fixed when rigd starts.
- **Only one issuer is configured.** `cert_issuer` names exactly one issuer, so Caddy never falls back to ZeroSSL and behaves the same on every run. `ca: internal` renders `local_certs` and `skip_install_trust` and no `cert_issuer`, for tests. `skip_install_trust` keeps Caddy out of the keychain.
- **The token never appears in config.** `{file.…}` is still a placeholder in adapted JSON and is read only when Caddy provisions (checked). So neither `caddy adapt` output nor the admin API's `GET /config/` shows the token.
- **No wildcard routes.** The wildcard blocks exist only so that Caddy manages those certificates. Their only directive is `abort`, which closes the connection, as today's ask endpoint effectively does for an unknown name. They never reach a process.

## Customization

The owner writes sites and snippets in `proxy/custom.caddy`, and global options (such as `servers` timeouts or log levels) in `proxy/custom-global.caddy`. Rig creates both files empty, with a header comment, and never rewrites them. Caddy loads only the **accepted** copies.

- **Explicit apply.**
  - **The candidate.** `rig proxy reload`, or a save in the UI, builds a candidate: the generated main file and the route file, with the custom files as they are on disk.
  - **Pass.** If `caddy validate` passes, Rig copies the custom files to `accepted/` and reloads.
  - **Fail.** Nothing is copied or reloaded, and the command fails `PROXY_CUSTOM_INVALID` with Caddy's message, which names the file and line (checked). For example: `proxy/custom.caddy:11: unrecognized directive: not_a_directive`. A custom site that repeats a Rig hostname fails the same way: `ambiguous site definition: rig.b-relay.com`.
  - Rig's routes keep serving throughout.
- **Every failure has one cause.** A route change always validates against the accepted custom files, so a failure there is a route problem (`ROUTE_VALIDATE`). A custom apply changes only the custom files, so a failure there is a custom problem.
  - **Hostname clashes.** A new Rig route whose hostname an accepted custom site already serves is refused before validation, as `ROUTE_CONFLICT` naming `custom.caddy`, as a hostname the Host Caddyfile served was refused before.
  - **Wildcards the owner already serves.** Rig leaves out the generated wildcard block for any parent whose wildcard the custom files already serve, so a custom `*.share.b-relay.com` site never collides with Rig's.
- **Pending edits are visible.** While a custom file differs from its accepted copy, `rig doctor`, `rig proxy`, and the UI report it as pending, or as rejected with the last error.
- **Rig keeps control of its global options.** A candidate whose adapted `admin`, `storage`, or listener ports differ from what Rig rendered is refused, so a custom file cannot take the proxy away from Rig.

## Token storage and its limits

The token is a Cloudflare API token with **Zone → DNS → Edit** and **Zone → Zone → Read**, on the `b-relay.com` zone only. It is stored at `<root>/auth/acme-dns.token`, mode 0600, in the existing 0700 `auth/` directory. Rig checks that the file exists, belongs to the user, has mode 0600, and is not empty. It never reads, logs, or returns the contents.

The protection is honest but limited.

- **Anything running as clay can get the token.** Caddy runs as clay and clay can edit its config, so a custom `respond {file.…/acme-dns.token}` or a `file_server` would serve the token. Any process running as clay can also read the file directly. Mode 0600 protects it from other macOS users and nothing more. A separate Unix user would not help while clay controls the config, which is why b-secret is removed rather than kept.
- **The damage has a limit.** A leaked token can edit the records of one zone, which is enough to take over its traffic and obtain its certificates. It cannot touch other zones or the account.
- **The token must stay readable.** Caddy cannot provision without it, even when certificates are already stored (checked: validate fails with `API token '' appears invalid`). So deleting or `chmod`-ing the file takes the proxy down at its next restart. `rig doctor` checks the file, and Rig refuses to render without it.

**Cheaper hardening, documented but not built:**

- **Challenge delegation.** Add a CNAME per wildcard parent, `_acme-challenge.<parent>` → `<parent>.acme.<other zone>`, and set Caddy's `dns_challenge_override_domain` (validated on 2.10.2 and 2.11.7). The token then needs DNS Edit only on a separate, throwaway zone. A leaked token could still obtain certificates for the delegated names, but it could no longer redirect traffic or change any `b-relay.com` record. The cost is a second Cloudflare domain and one hand-made CNAME per new parent.
- **IP filtering.** Cloudflare's client IP filtering can restrict the token to the Mac's egress IP. This only works if that IP is stable.

## Certificates: one wildcard per parent

Rig knows every hostname, so it needs no on-demand TLS and no ask endpoint. Each served hostname is covered by `*.<hostname minus its first label>`. A parent must have at least two labels, so a bare `b-relay.com` would get its own certificate.

Applied to the hostnames that will exist:

| Hostnames                                                            | Covered by                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| `rig`, `pantry`, `pantry2`, `vitals`, `design`, `fletcher`, `melody` | `*.b-relay.com`, the certificate the front Caddy holds today |
| `api.melody`                                                         | `*.melody.b-relay.com`                                       |
| `private.share`                                                      | `*.share.b-relay.com`                                        |

Today's working-Target names (`dev.vitals`, `dev.design`, `dev.pantry2`) add one wildcard per parent each, as do old-style Previews under `*.rig` until they are destroyed.

Under ADR 0010, a Preview's hostname is a flat sibling of its Target's hostname: `pantry-feat-x-1a2b3c4d.b-relay.com`, `api-feat-x-1a2b3c4d.melody.b-relay.com`. As long as the Preview name lands in the first label (the default, or a `targets.preview.domain` such as `${rig.target}.<parent>`), the Target's wildcard already covers every Preview. A `targets.preview.domain` that puts the Preview name deeper gives every Preview a parent of its own, and therefore a certificate of its own.

We chose this over one certificate per hostname for three reasons:

- **Previews get TLS at once.** No DNS-01 round runs per Preview. Let's Encrypt allows 50 new certificates per registered domain per 7 days, shared with everything else that issues for `b-relay.com`. 5 failed authorizations per hostname per hour and 300 new orders per 3 hours also count. Renewals are exempt from the 50. One certificate per hostname would spend one of the 50 on every new Preview.
- **Branch names stay out of public logs.** Certificate Transparency logs publish every certificate's names. One certificate per hostname would publish every Preview's branch slug.
- **There are few certificates.** A new parent costs one DNS-01 issuance, about 10–60 s before that hostname has TLS. When a parent falls out of use, its block is dropped and its stored certificate expires on its own.

The `*.b-relay.com` key already lives on this Mac today, so keeping it adds no exposure. It is also valid for names that DNS sends to the Dokploy VM. That adds little risk, because the DNS token can obtain any certificate for the zone anyway. `certificates: hostname` writes no wildcard blocks, for a Host that prefers one certificate per hostname.

The first run uses `ca: letsencrypt-staging` (as the runbook does), so a token or DNS mistake spends no production attempts.

## Validation, reload, and rollback

Every change goes through the router's one serialized queue:

1. Render the candidate files: the main file, the route file, and the accepted custom files, or the candidate custom files during an apply.
2. Run `caddy validate` with Rig's binary. This is now a full validation, not just an adapt, because rigd runs as clay and can read the token, which the old Host Caddy's secrets did not allow. Validation provisions but starts nothing and contacts no network. It catches a missing or empty token, an unknown directive (with its file and line), ambiguous sites, and missing snippets (all checked).
3. Install the files atomically, keeping `.rig-backup` copies.
4. Reload through the admin socket. `caddy reload` finds the socket from the config (checked). If the socket is down, the change is written but not reloaded (see The Caddy process).
5. If the reload fails, restore the files and reload again, as `createCaddyRouter` does today: `ROUTE_RELOAD` for routes, or `PROXY_RELOAD` for custom files and Host config changes.

The invariant is that the files on disk are what Caddy serves, or else the last config that validated. A Caddy restarted by launchd, or by a reboot, therefore comes back in the same state.

## Protocol for the UI

These new actions follow the existing split between reads and mutations. None of them carries or returns the token, and the UI cannot set it.

- `proxy` (read) returns:
  - `caddy`: state (`running` | `stopped` | `unreachable` | `not-installed`), launchd domain, version, and ports.
  - `sites`: one entry per hostname, with `hostname` and `source` (`target` | `custom`).
    - A `target` site adds `project`, `target`, and `routes` (`[{ prefix, upstream | null }]`). A Target with two hostnames appears as two sites.
    - A `custom` site adds `line` and the upstreams of its `reverse_proxy` handlers, from `caddy adapt`.
    - Each site names the `certificate` subject that covers it.
  - `certificates`: `subject`, `issuer`, `notAfter`, `state` (`valid` | `pending` | `failed` | `expiring`), and `lastError`, read from stored certificate files and Caddy's JSON log.
  - `custom`: for each file, its path, `revision`, `acceptedRevision`, `state` (`applied` | `pending` | `rejected`), and `error { message, file, line }`.
  - `checks`: the doctor checks below.
- `proxy-custom` (read) returns `{ sites: { text, revision }, global: { text, revision } }`.
- `proxy-custom-edit` (mutation) takes `{ file: "sites" | "global", text, revision, dryRun? }`. It refuses a stale revision with `PROXY_CUSTOM_CHANGED`, then validates the candidate. With `dryRun` it only reports the result. Otherwise it writes the file (keeping `.bak`), accepts it, and reloads, using the config editor's write pattern.
- `proxy-apply` (mutation) applies the custom files and `proxy` settings as they are on disk. `rig proxy reload` and `rigd install` send it.

In a terminal, `rig proxy` prints the same view and `rig proxy reload` applies edits; both support `--help` and `-h`. In `rig doctor`, these checks replace `caddy-proxy`:

| Check                | Passes when                                                                            |
| -------------------- | -------------------------------------------------------------------------------------- |
| `proxy-process`      | The job is loaded in rigd's launchd domain and the socket answers.                     |
| `proxy-config`       | `GET /config/` equals the adapted files on disk. Otherwise, run `rig proxy reload`.    |
| `proxy-binary`       | Caddy is new enough and includes the DNS module.                                       |
| `proxy-token`        | The file is present, belongs to the user, has mode 0600, and is not empty.             |
| `proxy-ports`        | Rig's Caddy holds 80 and 443.                                                          |
| `proxy-certificates` | Every subject is valid for more than 7 days; otherwise the check names the last error. |
| `proxy-custom`       | Each custom file is applied. It reports a file that is pending or rejected.            |

Saving `custom.caddy` from the dashboard is Host-level power: a `file_server` could expose the home directory. That is the trust the dashboard already has, since it can deploy any Project, but the UI should say so.

## Existing installs

The first release reads both `providers.caddy` and `proxy`. A Host config with only `providers.caddy` works exactly as today, and `rig doctor` adds a notice pointing to `proxy`.

Switching is an edit to Host config followed by `rigd install`. The route file is reused as it is, `extra_config` moves to `site`, and the snippets those lines use (`backend_errors`) go into `custom.caddy`.

During the rollback window, keep `import cloudflare` in `site` and define an empty `(cloudflare) {}` in `custom.caddy`. Every route block then stays byte for byte something the old router accepts.

`daemon.start` is independent of all this. Existing tests and dashboard sandboxes have neither section and are unchanged. The glossary gains the proxy and boot-start terms when this is implemented.

## Cutover runbook (owner runs; `sudo` only where shown)

The end state is one Caddy. b-caddy, the router, and the ask service stay installed but idle until the rollback window ends.

**Prepare (no effect on live traffic)**

1. Create a Cloudflare API token with _Zone:DNS:Edit_ and _Zone:Zone:Read_ on `b-relay.com` only. Store it with `umask 077; pbpaste > ~/.rig/auth/acme-dns.token`.
2. Review the front config for anything beyond TLS and proxying (headers, timeouts, extra sites), and move whatever should stay into `~/.rig/proxy/custom.caddy`. Print it with `sudo cat "/Library/Application Support/b-secret/caddy/Caddyfile"`.
3. Back up: `cp -p ~/.rig/config.yaml ~/.rig/config.yaml.pre-0014; cp -Rp ~/.rig/proxy ~/.rig/proxy.pre-0014; cp -p /usr/local/etc/caddy-router.caddyfile /usr/local/etc/caddy-router.caddyfile.pre-0014`.
4. Stage on high ports with the staging CA.
   1. Replace `providers.caddy` with a `proxy` section: `ports: { http: 28080, https: 28443 }`, `tls.ca: letsencrypt-staging`, and `site: [import cloudflare, import backend_errors]`. Set `daemon.start: boot` if boot start is adopted. It can also be adopted earlier, on its own.
   2. Put `(cloudflare) {}` and the router's `(backend_errors)` snippet in `custom.caddy`.
   3. Run `rigd install`. In boot mode, paste the commands it prints, then run `rigd install` again.

   The router keeps serving the live sites, but Rig no longer reloads it. Avoid deploys until the cutover, or reload the router by hand after one.

5. Verify: `rig proxy` should list the wildcard certificates as valid (staging). Then check a site: `curl -sk --resolve rig.b-relay.com:28443:127.0.0.1 https://rig.b-relay.com:28443/ -o /dev/null -w '%{http_code}\n'`.
6. Set `tls.ca: letsencrypt`, run `rig proxy reload`, and wait until `rig proxy` shows production certificates. Then verify without `-k`: `curl --resolve rig.b-relay.com:28443:127.0.0.1 https://rig.b-relay.com:28443/`. The certificates are now stored before any traffic moves.

**Cut over (a few seconds of downtime)**

7. Set `ports: { http: 80, https: 443 }` in `~/.rig/config.yaml`, then run this one line: `sudo launchctl bootout system/com.b-relay.b-caddy && sudo launchctl disable system/com.b-relay.b-caddy && rig proxy reload`. The `disable` keeps b-caddy from taking the ports back at the next boot.
8. From another tailnet device, check pantry, vitals, design, the rig dashboard (including sign-in, since `X-Forwarded-For` now comes straight from Rig's Caddy), and one Preview. Then run `rig doctor`. In boot mode, at a quiet time, also restart with `sudo shutdown -r now` and, without logging in, check the sites again from another device.

**Roll back (any time in the window)**

9. Set `ports` back to 28080/28443, then run `rig proxy reload && sudo launchctl enable system/com.b-relay.b-caddy && sudo launchctl bootstrap system /Library/LaunchDaemons/com.b-relay.b-caddy.plist && /usr/local/bin/caddy reload --config /usr/local/etc/caddy-router.caddyfile`. The route file still has `import cloudflare`, so the router accepts it, and the reload picks up any route changed since step 4. rigd is still in managed mode, so later deploys do not reload the router. For anything longer than a brief rollback, continue with step 10.
10. Full rollback: restore `~/.rig/config.yaml.pre-0014` and run `rigd install`. With `providers.caddy` back and no `proxy` section, it removes Rig's Caddy job: by printed commands in boot mode, or itself otherwise.

**Decommission (after a quiet week)**

11. Remove the old jobs: `sudo launchctl bootout system/com.b-relay.caddy-router; sudo launchctl bootout system/com.b-relay.caddy-ask; sudo rm /Library/LaunchDaemons/com.b-relay.{b-caddy,caddy-router,caddy-ask}.plist; sudo launchctl enable system/com.b-relay.b-caddy`. The last command clears the disabled flag left for a label that no longer exists. Then remove b-secret and its users (owner), remove `/usr/local/etc/caddy-router.caddyfile*`, and revoke b-secret's Cloudflare token. `127.0.0.1:2019` is now free, and only Rig's Caddy remains.
12. Drop `import cloudflare` from `site` and `(cloudflare)` from `custom.caddy`, then run `rig proxy reload`.

## Open questions for the owner

1. **Customization shape.** Should custom edits go in two files (`custom.caddy` for sites and snippets, `custom-global.caddy` for global options) and be applied explicitly by `rig proxy reload` or a UI save, with doctor reporting pending edits? Or should Rig watch the files and apply them on save? _Recommendation: two files and explicit apply. Watching applies half-written edits, and an error reads better as a command's reply._
2. **Acquiring the binary.** Should Rig download Caddy itself from caddyserver.com's build service? The service builds the latest version on demand; its binaries are unsigned and have no published checksum, so a download cannot be pinned. Today's download was v2.11.7 with cloudflare v0.2.4, 53 MB, in 2 s. _Recommendation: not now. Use a configured path that Rig copies and checks, and add a download later if upgrades become a chore._
3. **Unknown names under a wildcard parent.** Should they get `abort` (connection closed) or a plain 404 page? _Recommendation: `abort`, which matches today's ask-denied behavior and reveals nothing._
4. **Token hardening.** Is a 0600 file scoped to DNS Edit on `b-relay.com` enough, or should ACME challenges be delegated by CNAME to a separate zone? _Recommendation: the scoped token now. Delegation is a cheap follow-up if a second domain is acceptable._
5. **Boot start.** Should rigd and its Caddy become system jobs that run as clay (`daemon.start: boot`, one sudo paste at install and at uninstall, never for upgrades)? And should `boot` become the default for `~/.rig`? _Recommendation: yes for this Host. Keep `login` as the default until #287's Services-needing-a-login question is settled._
6. **External mode.** Should `providers.caddy` be retired after the rollback window? _Recommendation: yes. Nothing else uses it, and retiring it removes the Host Caddyfile import detection and the reload command._
7. **DNS records.** Should Rig also create DNS records for Project hostnames with the same token, as a "Proxy/DNS" view might suggest? _Recommendation: not yet. Records already point at the Mac. Rig would show what each hostname resolves to, and could write records later under a separate decision._

The rig.yaml syntax for a second hostname on one Target is a separate decision. This ADR only keeps it possible.

## Prototype and survey evidence (2026-10-10, x86_64 macOS 15.7, nothing global touched)

**Config validity**

- The generated file validated with **Caddy 2.10.2** (the installed binary) and **2.11.7** (the build service's download). That includes the global-block `import`, `admin "unix/…|0600"`, `acme_dns`, and `cert_issuer acme { dns cloudflare {file.…}; resolvers …; dns_challenge_override_domain … }`.
- `auto_https prefer_wildcard` validates on 2.10.2 but **is refused by 2.11.7**.
- A non-glob `import` of a missing file fails validation, so Rig always creates the custom files and their accepted copies.

**Certificates**

- With an internal issuer on `127.0.0.1:38443`, both versions issued **only the wildcard certificates**, without `prefer_wildcard`.
- `rig.b-relay.com` was served `*.b-relay.com`, and `api-feat-x-1a2b3c4d.melody.b-relay.com` was served `*.melody.b-relay.com`.
- An unknown `unknown.rig.b-relay.com` had its connection closed by `abort`.
- A custom site next to a wildcard block was served by its own block.

**Token handling**

- `caddy adapt` kept `{file.<path>}` as a placeholder, so the token was not inlined.
- `caddy validate` passed with a fake token. With the token file at mode 000, it failed: `API token '' appears invalid`.

**Custom files and reloads**

- An invalid custom file failed validation with its file and line. A reload of it was refused, and the old config kept serving (200).
- A good edit reloaded over the socket.
- A custom site repeating a Rig hostname failed with `ambiguous site definition`.
- `caddy reload` found the socket from the config, and `caddy stop` over the socket exited cleanly. The socket was created `srw-------`.

**Ports**

- As uid 502, `*:444` and `0.0.0.0:444` bound. `127.0.0.1:444` and `100.85.72.39:444` failed with `EACCES`.

**Downloaded binary**

- The download API returned `caddy_darwin_amd64_custom`: unsigned x86_64 Mach-O, v2.11.7, Go 1.26.4, `caddy-dns/cloudflare` v0.2.4 (`libdns/cloudflare` v0.2.2), sha256 `f7f2a3cb…763f`.

**Live setup (survey)**

- `com.b-relay.caddy-router` is a system job with `username = clay`, readable with `launchctl print` as clay. It holds `127.0.0.1:2019`, `18080`, and `18443`.
- b-caddy runs as a non-root system job.
- The Mac resolves through Tailscale MagicDNS, FileVault is off, and the application firewall is off.
- The current rigd LaunchAgent runs `/Users/clay/.rig/bin/rigd` with `KeepAlive { SuccessfulExit: false }`.

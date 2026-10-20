# The Rig website

`web/` is the site published at `rig.b-relay.com`: a dashboard, rendered on the
server, that shows every Project on this Host and drives every `rigd`
control-plane action. There is no landing page; the overview is the root.

## Stack

Next.js (App Router) and React, run by Bun itself.
`scripts/build-dashboard.sh` builds it (`output: "standalone"`, images
unoptimized so no native image library is carried) and assembles a
self-contained server, `web/server.js` with the modules it needs and the static
files beside it. A release ships that build, and `rigd` runs it with the Bun
inside its own executable (`BUN_BE_BUN=1`); this repository's `rig.yaml` builds
and runs the same one, so the working Target serves what ships. The server, the
build, and the tests share one runtime. Every page is a Server
Component (`dynamic = "force-dynamic"` in the root layout): it reads `rigd` on
the server and streams its rows as they arrive, so the browser never holds the
control-plane token and never talks to `rigd` directly. Changes go through
Server Actions (`web/server/actions.ts`), which validate the command with the
same Zod schema `rigd` uses and answer an `Outcome`, a value or a failure with
`rigd`'s code and hint, rather than throwing.

## How it reaches rigd

An installed Rig runs the site from its release: `rigd` serves it on
`127.0.0.1:<dashboard.port>` with the access key in
`<RIG_ROOT>/auth/dashboard.key` passed to it as `RIG_WEB_KEY_FILE`, and with
`dashboard.domain` in Host config Rig's own Caddy publishes it at that
hostname, with `dashboard.trusted_clients` passed as
`RIG_WEB_TRUSTED_CLIENTS`. In this repository it is also a
Rig Service (`services.web` in `rig.yaml`), for developing it: it listens on
`127.0.0.1` only; the working Target serves it on a loopback port, and Caddy
publishes each Preview at `rig-<preview>.b-relay.com`. The repository runs no
stable Target: `rig.b-relay.com` is the installed release's dashboard.

It authenticates to `rigd` the way `rig` does. `rigd install` writes a random
token to `<RIG_ROOT>/auth/control-plane.token` (mode 600) and `rigd` records its
port in `<RIG_ROOT>/daemon/address.json`. For every read and action
`web/server/daemon.ts` finds `rigd` through the same discovery as `rig`
(`src/daemon/connection.ts`): it checks that the recorded process is still the
one that wrote the record (its pid and start time), and only then reads the
token and calls `rigd` with it. A stale record is reported, never contacted. A
restarted `rigd` on a new port is found on the next request. Editor replies are
checked against the reply schemas the editors declare.

`rigd` itself is unchanged: it still binds loopback, still requires the token,
and still refuses foreign browser origins.

## Live refresh

The top bar's refresh button (`web/components/live-refresh.tsx`) keeps the page
current while the tab is visible. Every 15 seconds (every 3 while an action this
page started is still running, and once more when the tab comes back into view)
it fetches `/pulse`: a small stamp (`web/lib/pulse.ts`) built from `rigd`'s
identity, its queue and its newest recorded Operation. Only a changed stamp, a
running Operation, or two quiet minutes trigger a `router.refresh()`, in which
the server re-reads `rigd` and streams new rows while the browser keeps its
scroll and form state. Because most ticks change nothing, Next's client cache
(`staleTimes.dynamic`) can hand back a section seen in the last five minutes the
instant its tab is tapped, and the refresh replaces it when `rigd` moves.

When `/pulse` does not answer at all, the corner says `offline` and nothing
else changes; the page is left as it was and the next tick tries again. A
navigation attempted while the network is down waits for it to return
(`experimental.useOffline`) instead of falling through to the browser's error
screen.

## Pages

A sidebar (`web/components/shell/sidebar.tsx`) lists the Host-wide sections
(Overview, Monitor, Proxy) and every Project with its icon,
health and Targets, each with a state dot, streamed in as `rigd` answers. Below the width where it
stays open it is a drawer the top bar opens, and a phone keeps the sections as
tabs along the bottom. Status reads are shared per request
(`web/server/status.ts`), so the sidebar and the page pay for one observation.
The theme switch cycles system, light and dark and keeps the choice in a
`rig_theme` cookie, so the server renders the right scheme on the first paint
with no inline script; `dark:` utilities follow the same rule as the palette.

- **Overview** (`/`): counts across the Host, then one matrix per Project
  (below). Each Target card offers the actions its state calls for
  (`web/lib/target-verbs.ts`) behind its menu, and a Start button while it is
  not running: Start, or Restart and Stop, and Deploy latest for the stable
  Target and Previews, which deploys the head of the Production Branch or of
  the Preview's own Branch after a confirmation.
- **Monitor** (`/monitor`): this Mac at a glance. The side column holds rigd
  (version, queue, what it is running now, and what Rig itself uses, live),
  Doctor's Host checks (failed checks first with their reason and hint), and
  Activity for every Project; uninstall readiness folds under it. These stand
  even when the usage read fails. The main column stacks every Project's CPU
  and memory in one chart each, coloured like their monograms, with every
  Project's peak flagged where it happened (labels move apart rather than
  hide) and Activity marked on the time axis; then a card per registered
  Project, sampled or not, with its own charts (median dashed, peak flagged)
  and latest Activity. `1h`, `24h` and `7d` are presets: each reads the window
  that ends now. Charts read `/usage` again after every sample, at the pace of
  the newest report, a plain GET as the log follow is. Pointing at a chart,
  tapping it on a phone, or focusing it and using the arrow keys shows a
  moment's values; Escape hides them. On a phone, rigd and Doctor sit side by
  side above the charts, and Doctor lists only failed checks. `/doctor` and
  `/rigd` redirect here; `/activity` keeps the full history and each
  Operation's record.
- **A Project** (`/projects/<name>`): Overview (the Project's matrix), Deployments,
  Logs, Monitor, Environment, Jobs, Config and Settings. Monitor shows one Target
  at a time, picked from a monospace chip beside the Project's name
  (`pantry / stable`; `working`, a Preview's name, or `all targets`), with the
  Project's Doctor checks (one line on a phone while all pass) and its Activity
  beside the Target's charts and a card per configured Service and Job, sampled
  or not, each listing its own latest Activity and marking it on its charts. The old `/deploy` address redirects to Deployments, and `/doctor` to
  Monitor; `/activity` keeps the Project's full history.
- **A Target** (`/projects/<name>/targets/<target>`): its state, hostname,
  revision and actions, then Overview (each Service's state, cached health,
  named ports, pid, automatic restarts and how a stopped one ended; the paths
  its hostname serves with the Service and port each reaches; the deployment it
  runs), Deployments, Logs, Environment and Jobs, each for that Target alone.
- **Logs** (`web/components/log-viewer.tsx`): a Target's lines followed a second
  at a time through `rigd`'s cursor, read with a plain GET (`/log-lines`) because Next runs Server Actions one at a time and a deploy started from the page would hold the follow. Component chips and the stream picker
  narrow `rigd`'s own read (`logFilter`); the search box narrows and marks what
  is shown. Scrolling up holds the view until Latest; lines can wrap, be
  cleared, or be downloaded as `rig logs` prints them.
- **Deployments**: every deploy newest first as a stack of cards, with its outcome, Target, Branch
  and Commit (and the one it replaced), when it started and how long it took,
  beside the form that deploys a Branch or a Commit. The deploy that put the
  running Commit in place is marked current; Roll back to this deploys an
  earlier deploy's exact Commit of its Branch again. `rigd` records the history
  (below); rolling back is an ordinary deploy that names a Commit.
- **Environment**: the Project's secrets (below), and on a Target, each
  Service's names with the file that wins and the files it overrides.
- **Config**: the structured editor (below). `rigd` checks the draft a moment
  after typing stops and each problem shows beneath its field.
- **Jobs**: each Target's scheduled jobs as cards, from status (`targets[].jobs`,
  [ADR 0013](adr/0013-scheduled-jobs.md)) with their schedule and zone, last
  run, outcome and next run, and why one is not scheduled. **Run now** sends
  what `rig run <job> <target>` sends (`action: "run"` with `job`); it is
  offered unless a run of the job is going or the job was removed by a deploy,
  and a refusal such as `JOB_RUNNING` shows beneath it.
  A backup job ([ADR 0017](adr/0017-backups.md)) offers **Back up now** in its
  place and lists its backups (from the `backups` read) with time, size and
  whether the schedule or `rig run` made each; **Restore** on a backup asks for
  the job's name to be typed, then sends what `rig backup restore` sends
  (`action: "restore"` with `job` and `backup`) through a server action of its
  own, `runRestore`, which checks what was typed on the server; the generic
  command action refuses `restore`. It is offered only for a job
  with a `restore` command, while no run of it goes, for a backup still on disk.
- **Activity** (`/activity`, linked from Monitor): Operations as a timeline
  grouped by local day, newest first, each linking to its own record
  (`?operation=<id>`).
- **Proxy** reads through one module, `web/lib/proxy.ts`. With Rig's own Caddy
  (ADR 0014), rigd's `proxy` read lists every hostname served, each Target's
  paths with their upstream or `withheld (503)` and the owner's `proxy.routes`,
  and status adds each Service and state; hostnames are matched bare and
  lowercase, and links carry an explicit scheme and port, or Caddy's HTTPS port
  when it is not 443. `proxy.routes` is read-only there: it is edited in
  config.yaml and applied with `rig proxy reload`. Without Rig's own Caddy
  (`PROXY_UNMANAGED`), every hostname comes from status. Its DNS section
  (ADR 0018) reads through `web/lib/dns.ts`: rigd's `dns` read gives the
  hostname check, with a Point at this Mac button per hostname that does not
  point here, and each zone's records, with Add and Edit dialogs and a Delete
  dialog that needs the record's name typed. Each change is a `dns-create`,
  `dns-update` or `dns-delete` command carrying the record as the page read
  it, so rigd refuses it once the record changed. rigd reads the token; the
  page never sees it. Without a proxy section or a token, the section shows
  the steps that set it up.

## Deploy history

`rigd` keeps the newest 500 deploys in `state.json` (an optional `deployments`
list, written in the same update as the deploy's Activity record and under the
same Operation id): the Target and its role, the Branch and Commit deployed (or
set out to deploy, for a failure), the Commit it replaced, the outcome
(`deployed`, `unchanged` or `failed`), the Services a successful deploy kept
running (`kept`, ADR 0016), when the deploy began its work and when it ended,
and a failure's error code. The `deployments` read answers a Project's history
with each deploy's duration, and the history page shows `kept db, search` under
a deploy that kept any.

## Secrets

The Environment tab edits the operator env files `rigd` layers into each
process ([ADR 0003](adr/0003-exclude-env-file-secrets-from-interpolation.md),
the guide's Environment section): `<RIG_ROOT>/env/<project>/all.env` and
`<role>.env`, and the same per Service under `<project>/<service>/` and per job
under `<project>/<job>/`, which each run, backup and restore of the job loads.
`rig.yaml`'s own `env_file` entries are not edited here.

`rigd`'s env editor (`/v1/env`, `src/daemon/env-editor.ts`) takes a registered
Project and a scope (a Service or a job `rig.yaml` declares, and a role or all),
never a path. Its `read` names each file's keys, revision and mode, never a
value; a value leaves `rigd` only through `reveal`, one at a time, when an
operator asks, with the revision it was read from. So no value is part of a
rendered page, the client cache or a URL; a revealed value lives in the page's
memory until it is hidden, the page is left, or a refresh shows the file at
another revision (or another file winning the name, on a Target's
Environment page): then it is masked again, and a reply for an older revision
is never shown.

A `write` applies set and remove changes line by line, keeping comments and
order, only if the file still has the revision the changes were made against
(checked again just before the rename, after the Project and scope are read
again under the Project's lock, so a rename, forget or repoint that finished
first refuses it). The dashboard keeps that revision with its unsaved changes
(`web/lib/env-draft.ts`): a live refresh shows the newer file and keeps the
changes, naming the names added or removed since; saving them is refused as
`ENV_REVISION_CONFLICT` until the operator reviews them against the current
file. The config editor's draft does the same with `rig.yaml`
(`followRead` in `web/lib/config-form.ts`). The new content goes to a private temporary file
renamed over the old, so a reader never sees half of either; the file is 0600
and every directory from `<RIG_ROOT>/env` down to it 0700. A symlinked file
stays a symlink. Each value is quoted so the env-file reader reads it back
exactly, and refused by name when it cannot be. Each write records an Activity
entry (`env`, `updated`) naming who asked and which names changed in which
file, never a value. Every such request is signed in, so the server names where
it came from, from the request itself and never from the browser:
`dashboard (this Mac)` or `dashboard (<address>)`. Refusals
never repeat the request. After a save, the running Targets that read the file
are offered a restart, since processes read env files when they start; a job's
file needs none, since its next run or restore reads it.

## The matrix

Each Project is one matrix (`web/components/project-matrix.tsx`, laid out from
the pure `web/lib/matrix.ts`). The Project's own card sits in the corner: its
icon with a health dot, and its name. Its Targets run across the top as cards
(state dot, name, actions, `branch @ commit`, hostname), in working, stable,
Preview order; its Services, stores, Tools and then jobs run down the side; and
each row has a tinted tile on each Target with its state and port, or, for a
job, how its last run ended and when it runs next. A Service a deploy kept
running from an earlier Commit than its Target's carries a pin beside its port,
and its tooltip (and its card on the Target page) says `kept from <sha>`. A row a Target does not have
is a dashed outline. A Target `rig.yaml` turns on is shown (as configured)
before it first runs, so the working Target is started from its own card; an
off Target is shown only while it is still recorded. A missing directory or a
status `rigd` refused takes the place of the Target cards, and Project warnings
are listed beneath.

The top row and the left column are frozen in one scroll area, so they move in
the same frame as the tiles; tiles snap to whole tiles and fade out at the
frozen edges and the far edges rather than slide under them, with no visible
scrollbars. On a phone a Target column is nearly the width beside the frozen
column, so Targets snap into view one at a time.

A Project's icon is its stable Target's favicon when its published site has
one, otherwise its first two letters in Space Grotesk on one of five chart
colours chosen from its name, so it wears the same colour on every page. The
page never loads another origin's image, and the server never resolves a
Project's public hostname: `/project-icon?project=<name>` asks the stable
Target's own Service for `/favicon.ico` on `127.0.0.1` (the port `rigd`'s status
routes `/` to, never anything the request names), sending the Target's hostname
as `Host`. A source that is not loopback is refused before anything is sent;
redirects are not followed; the answer must be under 100 kB and its bytes a PNG,
ICO, JPEG, GIF or WebP (never SVG, whatever its label), and is served with the
type its bytes show and `nosniff`. Each answer is kept on the server for ten
minutes and served from the site's own origin behind the same admission as
every page; anything else is a 404 and the monogram stays.

## Lost replies

Some actions cut the page off before its reply arrives: stopping or destroying
the Target that serves it, or any action that makes Caddy reload while the
request is in flight. Every command is sent with an `operationId` the page
chose, so when the transport fails the page asks `rigd` where that Operation
stands (`settleOperation` in `web/server/actions.ts`, resolved by the pure
`web/lib/reconcile.ts`) and reports the real outcome: still running, finished
with the outcome the command would have answered, or never received.

## Who may use the site

Every page reads `rigd` and every action drives it, so `web/proxy.ts` decides
every request with `web/server/guard.ts` before anything renders, each Server
Action decides again, and the code that reaches `rigd` (`web/server/daemon.ts`)
refuses a request that has not presented the key, whatever page, route or action
asked. A request is admitted only when all of these hold:

- The `Host` header is the published name (`RIG_WEB_HOST`, set from
  `${rig.host}`) or the Service's own loopback address. This defeats DNS
  rebinding.
- Any `Origin` is one of the site's own origins. A `POST` must carry an
  `Origin`, so another website cannot forge an action. A `Sec-Fetch-Site` other
  than `same-origin` is allowed only for a plain navigation (`GET` with
  `Sec-Fetch-Mode: navigate`), so a link from elsewhere opens the board the
  way a bookmark does, but nothing else from elsewhere gets an answer.
- When `RIG_WEB_TRUSTED_CLIENTS` lists addresses (comma-separated IPs or IPv4
  CIDR blocks, for example a Tailscale range `100.64.0.0/10`), every address in
  `X-Forwarded-For` is loopback or one of them; any other address is refused
  outright, even with the key or a session. Caddy replaces that header with the
  address it saw. Empty (the default), it limits nothing: any address that
  reaches the site may sign in. Either way an address only lets a browser reach
  the site and sign in; it is never signed in by itself.
- The request carries none of the headers a tunnel or a second proxy adds
  (`Forwarded`, `X-Real-IP`, `CF-Connecting-IP`, and similar). Behind a tunnel
  Caddy sees the tunnel's loopback address for every visitor, so such requests
  are refused outright. Do not publish the dashboard through cloudflared,
  Tailscale Funnel, ngrok, or `ssh -R`.
- This copy of the site is not a Preview of the Host's dashboard.
  `RIG_WEB_DASHBOARD_HOST` names the one published host whose dashboard controls
  the Host's `rigd`; any other published copy refuses every request unless it
  is sandboxed (below), so an unreviewed Branch never holds Host control.
- The request presents the access key (below), from this Mac as from anywhere
  else. Only the sign-in page and its own action are served without it.

A malformed `RIG_WEB_TRUSTED_CLIENTS` entry stops the server at startup rather
than being skipped or widened. The proxy runs on every path. Only the readiness
probe (`/healthz`), `/favicon.ico` and the build's own files under
`/_next/static/` are served without the key, each matched exactly, so a path
that only starts like one is decided like any page. The root layout decides the
request again by itself and shows the sidebar and `rigd`'s state only to a
signed-in browser, so not even a not-found page shows them to anyone else.
Every response carries a per-request nonce Content-Security-Policy (scripts
only from the site itself, no framing), and every page `Cache-Control:
no-store`.

## Signing in

`RIG_WEB_KEY_FILE` names a file holding a random access key; the site creates
it, mode 600, on first start and logs the file's path, never the key. Without
it no browser can sign in, so the site admits no one. Every browser, on this
Mac too, signs in with the key, and is returned to its page afterwards. Read
the key with `cat`:

- the dashboard that comes with Rig: `<RIG_ROOT>/auth/dashboard.key`
  (`~/.rig/auth/dashboard.key` by default);
- a Target serving the site from this repository (a working copy or a
  Preview): `${rig.data}/access.key` (`RIG_WEB_KEY_FILE` in `rig.yaml`), whose
  path the Target's log names (`rig logs`).

How the key is presented depends on the address the browser uses, because a
browser sends a cookie to every port of a host name, whatever port set it:

- **On the loopback address** (`http://127.0.0.1:<port>`, plain HTTP on this
  Mac), the sign-in page has the browser itself ask for the key (an HTTP
  `Basic` challenge): enter any user name, such as `rig`, and the key as the
  password. The browser keeps them for that origin alone, scheme, host and port
  together, and sends them with every request there. No cookie is issued or
  accepted on this address, so another program listening on another port of
  `127.0.0.1` never receives anything that signs in here. Dismissing the prompt
  shows the key file's exact path. The browser forgets the key when it quits.
- **Under the published name** (`https://<name>`), the sign-in page takes the
  key once and answers a session cookie. On this Mac (through Caddy) the page
  names its key file's exact path; a browser elsewhere is told only where it
  lives.

The session cookie, `rig_session` (`HttpOnly`, `Secure`, `SameSite=Lax`,
`Path=/`), is an HMAC of its expiry under the key, so there is no session store:
delete the key file and restart the Service to replace the key and end every
session. Only the published name's certificate can answer for it, so no other
listener receives it. `SameSite=Lax`, not `Strict`: a browser
sends a `Strict` cookie only on navigations started from the site itself, so
opening the dashboard from a bookmark, a home-screen icon or a link in another
app would land on the sign-in page. `Lax` still withholds the cookie from
another site's `POST`s, and every change is a `POST` (a Server Action, which the
origin rules above also refuse from elsewhere); a `GET` only reads. The cookie
lasts 400 days, the longest a browser keeps one, and every page load renews it,
so a browser in use stays signed in until the key is replaced. The host,
origin, client and tunnel rules above still apply to a signed-in client.

With a trusted list and `rig.b-relay.com` resolving to a Tailscale or LAN
address, Caddy sees even a browser on this Mac arrive from that address, not
from loopback, so that address must be in the list for the browser to reach the
sign-in page.

Anyone holding the key has full control of every Project on the Host. Being on
this Mac grants nothing by itself: a process that cannot read the key file
(another macOS user, a sandboxed app) reaches the loopback port but gets only
the sign-in challenge. What remains: a browser sends the loopback credentials
to whatever answers on the dashboard's own port, so a program that takes that
port while the dashboard is stopped would receive them.

## Preview sandboxes

`targets.preview` in `rig.yaml` sets `RIG_WEB_SANDBOX_ROOT` to
`${rig.data}/rigd`. With it set, the site's startup hook
(`web/instrumentation.ts`, which runs `web/server/startup.ts`) runs
`rigd install` against that root before serving and `rigd uninstall` when the
Service stops, and every page reads that root instead of `~/.rig`. A Rig root
other than `~/.rig` runs `rigd` as a plain process, never in launchd, with its
own token, state, and Caddyfile (`<root>/proxy/Caddyfile`, never reloaded), so
a Preview's dashboard is fully usable and cannot touch the Host's Projects or
routes. `NEXT_MANUAL_SIG_HANDLE` is set so the site, not Next, owns `SIGTERM`
and can take the sandbox down first.

A new sandbox is seeded from `web/demo`: each directory there is copied into the
Preview's data directory, committed, and registered (`web/server/seed.ts`);
`pantry` and `ledger` are deployed and `pantry` also gets a Preview, so every
screen has something to show. Seeding runs after the site starts serving, and a
Project already present is left alone, so a restart keeps what a visitor
changed. Sandbox Targets get ports but no published URLs. When the Service
stops, the site stops every sandbox Target through the sandbox's control plane
and then runs `rigd uninstall`; `rig down preview <branch> --destroy` deletes
the rest with the Preview's data.

The sandbox isolates state, not privileges: a Project registered in it still
runs its commands as you.

## Layout

| Path                  | Responsibility                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/app`             | Routes. `/` is the overview; `/projects/[name]/(sections)/*` the Project sections and `/projects/[name]/targets/[target]/*` a Target's; `/monitor`, `/activity`, `/proxy`, `/projects/new`, `/sign-in`; `/healthz` for readiness; `/project-icon` a Project's favicon; `/usage` and `/log-lines` the polled reads.                                              |
| `web/proxy.ts`        | Admits each request, sends strangers to `/sign-in`, and sets the nonce CSP.                                                                                                                                                                                                                                                                                     |
| `web/server`          | `site.ts` (settings from env), `daemon.ts` (reads, config and env edits against rigd), `actions.ts` (Server Actions), `status.ts`, `deployments.ts` and `env.ts` (per-request reads), `guard.ts`, `startup.ts`, `sandbox.ts`, `seed.ts`, `favicon.ts` (Project icons read on the server).                                                                       |
| `web/components`      | Server and client components; `shell/` the sidebar and menu; `project-matrix.tsx` the overview's matrices and `project-icon.tsx` the Project icons; `bits.tsx` the shared card, dot and tile pieces; `operations.tsx` owns in-flight actions and reconciliation.                                                                                                |
| `web/components/ui`   | shadcn/ui primitives (fetched from the registry, edited in place).                                                                                                                                                                                                                                                                                              |
| `web/lib`             | Pure helpers: `reconcile.ts`, `present.ts`, `health.ts`, `matrix.ts`, `activity.ts`, `target.ts`, `overview.ts`, `target-verbs.ts`, `target-detail.ts`, `logs.ts`, `usage.ts`, `chart-layout.ts`, `deployments.ts`, `env.ts`, `jobs.ts`, `proxy.ts`, `dns.ts`, `theme.ts`, `config-form.ts`, `outcome.ts`, and the control-plane `types.ts` reused from `src/`. |
| `web/app/globals.css` | Tailwind entry: the slate-teal palette (light and dark) with the good, warn and bad state tones, and the shadcn tokens mapped onto them. Inter, Space Grotesk and JetBrains Mono load in `layout.tsx` with `next/font/local`.                                                                                                                                   |
| `web/demo`            | Demo Projects every Preview sandbox is seeded with.                                                                                                                                                                                                                                                                                                             |

Radix primitives set inline styles, so the Content-Security-Policy allows
`style-src 'unsafe-inline'`; scripts need the per-request nonce.

The config editor never asks for field paths. It holds the parsed `rig.yaml` as
a draft, renders it as forms (Project, Environment, Services, Tools, Proxy,
Targets), and on "Review changes" diffs the draft against what rigd read into
`set`/`remove` edits for `rigd`'s config editor. rigd previews them against the
schema, shows the before/after table, and applies with the revision it read. If
`rig.yaml` changed on disk in between, rigd refuses the apply; the dashboard
then reads the file again, keeps the draft, and re-derives the diff against the
newer file for another review. rigd's YAML editor keeps comments: it replaces or
removes a mapping or list only while nothing inside it is commented, so removing
a Service whose block carries comments must be done in an editor.

## Running it

```sh
# against your installed rigd, with hot reload, signing in with its dashboard's key
RIG_WEB_KEY_FILE=~/.rig/auth/dashboard.key PORT=4173 bun run web:dev
# against an isolated one
RIG_ROOT=/tmp/rig-dev/.rig RIG_WEB_KEY_FILE=/tmp/rig-dev/.rig/auth/dashboard.key PORT=4173 bun run web:dev
# the production build
bun run web:build && RIG_WEB_KEY_FILE=~/.rig/auth/dashboard.key PORT=4173 bun run web:start -- -p 4173
```

Without `RIG_WEB_KEY_FILE` the site admits no one. Then open
`http://127.0.0.1:4173/` and give the browser the key from that file
(`cat` it) as the password. To publish it, run `rig init` in this
repository once and `rig deploy`; DNS for `rig.b-relay.com`, and for
`rig-<preview>.b-relay.com` to reach Previews, must resolve to this Mac.

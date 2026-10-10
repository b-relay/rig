# The Rig website

`web/` is the site published at `rig.b-relay.com`: a dashboard, rendered on the
server, that shows every Project on this Host and drives every `rigd`
control-plane action. There is no landing page; the overview is the root.

## Stack

Next.js (App Router) and React, run by Bun itself: `rig.yaml` builds with
`bun --bun next build web` and serves with `bun --bun next start web`, so the
server, the build, and the tests share one runtime. Every page is a Server
Component (`dynamic = "force-dynamic"` in the root layout): it reads `rigd` on
the server and streams its rows as they arrive, so the browser never holds the
control-plane token and never talks to `rigd` directly. Changes go through
Server Actions (`web/server/actions.ts`), which validate the command with the
same Zod schema `rigd` uses and answer an `Outcome`, a value or a failure with
`rigd`'s code and hint, rather than throwing.

## How it reaches rigd

The site is a Rig Service (`services.web` in this repository's `rig.yaml`). It
listens on `127.0.0.1` only; Caddy publishes the stable Target at
`rig.b-relay.com` and each Preview at `rig-<preview>.b-relay.com`.

It authenticates to `rigd` the way `rig` does. `rigd install` writes a random
token to `<RIG_ROOT>/auth/control-plane.token` (mode 600) and `rigd` records its
port in `<RIG_ROOT>/daemon/address.json`. For every read and action
`web/server/daemon.ts` reads both, checks that the recorded process is still
alive, and calls `rigd` with the token. A restarted `rigd` on a new port is
found on the next request.

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
(Overview, Activity, Proxy, Doctor, rigd) and every Project with its Targets,
each with a state dot, streamed in as `rigd` answers. Below the width where it
stays open it is a drawer the top bar opens, and a phone keeps the sections as
tabs along the bottom. Status reads are shared per request
(`web/server/status.ts`), so the sidebar and the page pay for one observation.
The theme switch cycles system, light and dark and keeps the choice in a
`rig_theme` cookie, so the server renders the right scheme on the first paint
with no inline script; `dark:` utilities follow the same rule as the palette.

- **Overview** (`/`): counts across the Host, then one card per Project. Each
  Target shows its role, state, hostname, Branch and Commit and Services, and
  the actions its state calls for (`web/lib/target-verbs.ts`): Start, or
  Restart and Stop, and Deploy latest for the stable Target and Previews, which
  deploys the head of the Production Branch or of the Preview's own Branch
  after a confirmation. `?view=table` shows the board below instead.
- **A Project** (`/projects/<name>`): Overview (a card per Target), Deployments,
  Logs, Environment, Jobs, Config, Activity, Doctor and Settings. The old
  `/deploy` address redirects to Deployments.
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
- **Deployments**: every deploy newest first, with its outcome, Target, Branch
  and Commit (and the one it replaced), when it started and how long it took,
  beside the form that deploys a Branch or a Commit. The deploy that put the
  running Commit in place is marked current; Roll back to this deploys an
  earlier deploy's exact Commit of its Branch again. `rigd` records the history
  (below); rolling back is an ordinary deploy that names a Commit.
- **Environment**: the Project's secrets (below), and on a Target, each
  Service's names with the file that wins and the files it overrides.
- **Config**: the structured editor (below). `rigd` checks the draft a moment
  after typing stops and each problem shows beneath its field.
- **Jobs**: each Target's scheduled jobs from status (`targets[].jobs`,
  [ADR 0013](adr/0013-scheduled-jobs.md)) with their schedule and zone, last
  run, outcome and next run, and why one is not scheduled. **Run now** sends
  what `rig run <job> <target>` sends (`action: "run"` with `job`); it is
  offered unless a run of the job is going or the job was removed by a deploy,
  and a refusal such as `JOB_RUNNING` shows beneath it.
- **Proxy** reads through one module, `web/lib/proxy.ts`, which lists every
  hostname from status until a Rig-owned Caddy (`feat/rig-owned-caddy`) reports
  them, with a typed stub for the custom Caddy file; it names that branch in a
  TODO.

## Deploy history

`rigd` keeps the newest 500 deploys in `state.json` (an optional `deployments`
list, written in the same update as the deploy's Activity record and under the
same Operation id): the Target and its role, the Branch and Commit deployed (or
set out to deploy, for a failure), the Commit it replaced, the outcome
(`deployed`, `unchanged` or `failed`), when the deploy began its work and when
it ended, and a failure's error code. The `deployments` read answers a
Project's history with each deploy's duration.

## Secrets

The Environment tab edits the operator env files `rigd` layers into each
process ([ADR 0003](adr/0003-exclude-env-file-secrets-from-interpolation.md),
the guide's Environment section): `<RIG_ROOT>/env/<project>/all.env` and
`<role>.env`, and the same per Service under `<project>/<service>/`. `rig.yaml`'s
own `env_file` entries are not edited here.

`rigd`'s env editor (`/v1/env`, `src/daemon/env-editor.ts`) takes a registered
Project and a scope (a Service `rig.yaml` declares, and a role or all), never a
path. Its `read` names each file's keys, revision and mode, never a value; a
value leaves `rigd` only through `reveal`, one at a time, when an operator asks.
So no value is part of a rendered page, the client cache or a URL; a revealed
value lives in the page's memory until it is hidden or the page is left.

A `write` applies set and remove changes line by line, keeping comments and
order, only if the file still has the revision the page read (checked again
just before the rename). The new content goes to a private temporary file
renamed over the old, so a reader never sees half of either; the file is 0600
and every directory from `<RIG_ROOT>/env` down to it 0700. A symlinked file
stays a symlink. Each value is quoted so the env-file reader reads it back
exactly, and refused by name when it cannot be. Each write records an Activity
entry (`env`, `updated`) naming who asked and which names changed in which
file, never a value; the server names who from the request's own admission
(signed in, this Mac, or the trusted address), never the browser. Refusals
never repeat the request. After a save, the running Targets that read the file
are offered a restart, since processes read env files when they start.

## The board

`web/components/board.tsx` gathers every Project's status, and
`web/lib/board-rows.ts` flattens the reports into one row per Target, in
working, stable, Preview order, with Project-level notices lifted above the
table. A Target `rig.yaml` turns on is listed (as configured) before it first
runs, so the working Target is started from its own row; an off Target is
listed only while it is still recorded.
`web/components/targets-table.tsx` renders them as a TanStack data table:
sortable columns, a filter box, a column chooser remembered in the browser, and
the Target and actions columns pinned to either edge while the rest scroll.

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
each request with `web/server/guard.ts` before a page renders, and each Server
Action decides again. A request is admitted only when all of these hold:

- The `Host` header is the published name (`RIG_WEB_HOST`, set from
  `${rig.host}`) or the Service's own loopback address. This defeats DNS
  rebinding.
- Any `Origin` is one of the site's own origins. A `POST` must carry an
  `Origin`, so another website cannot forge an action. A `Sec-Fetch-Site` other
  than `same-origin` is allowed only for a plain navigation (`GET` with
  `Sec-Fetch-Mode: navigate`), so a link from elsewhere opens the board the
  way a bookmark does, but nothing else from elsewhere gets an answer.
- Every address in `X-Forwarded-For` is loopback or listed in
  `RIG_WEB_TRUSTED_CLIENTS` (comma-separated IPs or IPv4 CIDR blocks, for
  example a Tailscale range `100.64.0.0/10`). Caddy replaces that header with
  the address it saw, so by default the dashboard works only from the Mac that
  serves it.
- The request carries none of the headers a tunnel or a second proxy adds
  (`Forwarded`, `X-Real-IP`, `CF-Connecting-IP`, and similar). Behind a tunnel
  Caddy sees the tunnel's loopback address for every visitor, so such requests
  are refused outright. Do not publish the dashboard through cloudflared,
  Tailscale Funnel, ngrok, or `ssh -R`.
- This copy of the site is not a Preview of the Host's dashboard.
  `RIG_WEB_DASHBOARD_HOST` names the one published host whose dashboard controls
  the Host's `rigd`; any other published copy refuses every request unless it
  is sandboxed (below), so an unreviewed Branch never holds Host control.

A malformed `RIG_WEB_TRUSTED_CLIENTS` entry stops the server at startup rather
than being skipped or widened. Every response carries a per-request nonce
Content-Security-Policy (scripts only from the site itself, no framing) and
`Cache-Control: no-store`.

## Signing in from another device

`RIG_WEB_KEY_FILE` (set to `${rig.data}/access.key` in `rig.yaml`) names a file
holding a random access key; the Service creates it, mode 600, on first start and
logs the file's path, never the key. A client that is not loopback or in
`RIG_WEB_TRUSTED_CLIENTS` is sent to the sign-in page (`/sign-in?next=<path>`,
which carries none of the site's frame) and returned to its page afterwards.
Presenting the key answers a `rig_session` cookie (`HttpOnly`, `Secure`,
`SameSite=Strict`, `Path=/`) that is an HMAC of its expiry under the key, so
there is no session store: delete the key file and restart the Service to
replace the key and end every session. The cookie lasts 400 days, the longest a
browser keeps one, and every page load renews it, so a browser in use stays
signed in until the key is replaced. The key itself is never stored in the
browser. The host, origin, and tunnel rules above still apply to a signed-in
client.

This matters even on the Mac itself when `rig.b-relay.com` resolves to a
Tailscale or LAN address: Caddy then sees the browser arrive from that address,
not from loopback. Read the key with `cat` on the path the log names
(`rig logs stable --project rig`).

Anyone holding the key has full control of every Project on the Host. Without
`RIG_WEB_KEY_FILE`, clients beyond the trusted addresses are refused outright.

One gap remains: a process on this Mac that cannot read the token file (another
macOS user, a sandboxed app) can still reach the Service's loopback port, where
no key is asked for, and forge the headers above. `rigd` alone does not have this
gap. On a single-user Mac the practical difference is small, since your own
processes can read the token anyway.

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

| Path                  | Responsibility                                                                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/app`             | Routes. `/` is the overview; `/projects/[name]/(sections)/*` the Project sections and `/projects/[name]/targets/[target]/*` a Target's; `/activity`, `/proxy`, `/doctor`, `/rigd`, `/projects/new`, `/sign-in`; `/healthz` for readiness.                                     |
| `web/proxy.ts`        | Admits each request, sends strangers to `/sign-in`, and sets the nonce CSP.                                                                                                                                                                                                   |
| `web/server`          | `site.ts` (settings from env), `daemon.ts` (reads, config and env edits against rigd), `actions.ts` (Server Actions), `status.ts`, `deployments.ts` and `env.ts` (per-request reads), `guard.ts`, `startup.ts`, `sandbox.ts`, `seed.ts`.                                      |
| `web/components`      | Server and client components; `shell/` the sidebar and menu; `project-card.tsx` the overview's cards; `board.tsx` and `targets-table.tsx` the table view; `operations.tsx` owns in-flight actions and reconciliation.                                                         |
| `web/components/ui`   | shadcn/ui primitives (fetched from the registry, edited in place).                                                                                                                                                                                                            |
| `web/lib`             | Pure helpers: `reconcile.ts`, `present.ts`, `target.ts`, `overview.ts`, `target-verbs.ts`, `target-detail.ts`, `logs.ts`, `deployments.ts`, `env.ts`, `jobs.ts`, `proxy.ts`, `theme.ts`, `config-form.ts`, `outcome.ts`, and the control-plane `types.ts` reused from `src/`. |
| `web/app/globals.css` | Tailwind entry: the Rig palette, fonts, and the shadcn tokens mapped onto them.                                                                                                                                                                                               |
| `web/demo`            | Demo Projects every Preview sandbox is seeded with.                                                                                                                                                                                                                           |

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
PORT=4173 bun run web:dev                                   # against your installed rigd, with hot reload
RIG_ROOT=/tmp/rig-dev/.rig PORT=4173 bun run web:dev       # against an isolated one
bun run web:build && PORT=4173 bun run web:start -- -p 4173  # the production build
```

Then open `http://127.0.0.1:4173/`. To publish it, run `rig init` in this
repository once and `rig deploy`; DNS for `rig.b-relay.com`, and for
`rig-<preview>.b-relay.com` to reach Previews, must resolve to this Mac.

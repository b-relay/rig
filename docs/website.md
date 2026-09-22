# The Rig website

`web/` is the site published at `rig.b-relay.com`: a dashboard, rendered on the
server, that shows every Project on this Host and drives every `rigd`
control-plane action. There is no landing page; the board is the root.

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
listens on `127.0.0.1` only; Caddy publishes the Stable Target at
`rig.b-relay.com` and each Preview at `<preview>.rig.b-relay.com`.

It authenticates to `rigd` the way `rig` does. `rigd install` writes a random
token to `<RIG_ROOT>/auth/control-plane.token` (mode 600) and `rigd` records its
port in `<RIG_ROOT>/daemon/address.json`. For every read and action
`web/server/daemon.ts` reads both, checks that the recorded process is still
alive, and calls `rigd` with the token. A restarted `rigd` on a new port is
found on the next request.

`rigd` itself is unchanged: it still binds loopback, still requires the token,
and still refuses foreign browser origins.

## Live refresh

The top bar's refresh button (`web/components/live-refresh.tsx`) re-renders the
page from the server every 15 seconds while the tab is visible, every 3 seconds
while an action this page started is still running, and once more when the tab
comes back into view. Refreshing is a `router.refresh()`: the server re-reads
`rigd` and streams new rows; the browser keeps its scroll and form state.

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
(`rig logs live --project rig`).

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

| Path                  | Responsibility                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/app`             | Routes. `/` is the board; `/projects/[name]/*` the Project sections; `/activity`, `/doctor`, `/rigd`, `/projects/new`, `/sign-in`; `/healthz` for readiness.        |
| `web/proxy.ts`        | Admits each request, sends strangers to `/sign-in`, and sets the nonce CSP.                                                                                         |
| `web/server`          | `site.ts` (settings from env), `daemon.ts` (reads and config edits against rigd), `actions.ts` (Server Actions), `guard.ts`, `startup.ts`, `sandbox.ts`, `seed.ts`. |
| `web/components`      | Server and client components; `board.tsx` is the one table the root page is; `operations.tsx` owns in-flight actions and reconciliation.                            |
| `web/components/ui`   | shadcn/ui primitives (fetched from the registry, edited in place).                                                                                                  |
| `web/lib`             | Pure helpers: `reconcile.ts`, `present.ts`, `target.ts`, `config-form.ts`, `outcome.ts`, and the control-plane `types.ts` reused from `src/`.                       |
| `web/app/globals.css` | Tailwind entry: the Rig palette, fonts, and the shadcn tokens mapped onto them.                                                                                     |
| `web/demo`            | Demo Projects every Preview sandbox is seeded with.                                                                                                                 |

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
repository once and `rig deploy live` (or `git push rig main`); DNS for
`rig.b-relay.com` must resolve to this Mac.

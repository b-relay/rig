# The Rig website

`web/` is the site published at `rig.b-relay.com`: a landing page at `/` and a
dashboard at `/dashboard` that drives every `rigd` control-plane action.

## How it reaches rigd

The site is a Rig Service (`services.web` in this repository's `rig.yaml`). It
listens on `127.0.0.1` only; Caddy publishes the Stable Target at
`rig.b-relay.com` and each Preview at `<preview>.rig.b-relay.com`.

It authenticates to `rigd` the way `rig` does. `rigd install` writes a random
token to `<RIG_ROOT>/auth/control-plane.token` (mode 600) and `rigd` records its
port in `<RIG_ROOT>/daemon/address.json`. For every request the site's relay
(`web/server/relay.ts`) reads both, checks that the recorded process is still
alive, and forwards the request with the token. The browser never receives the
token, and a restarted `rigd` on a new port is found on the next request.

| Site route          | rigd route         |
| ------------------- | ------------------ |
| `GET /api/health`   | `GET /health`      |
| `POST /api/command` | `POST /v1/command` |
| `POST /api/config`  | `POST /v1/config`  |

`POST /api/session` is the site's own: it trades the access key for a session.

`rigd` itself is unchanged: it still binds loopback, still requires the token,
and still refuses foreign browser origins.

## Who may use the relay

The relay can do anything `rig` can, so `web/server/guard.ts` admits a request
only when all of these hold:

- The `Host` header is the published name (`RIG_WEB_HOST`, set from
  `${rig.host}`) or the Service's own loopback address. This defeats DNS
  rebinding.
- Any `Origin` is one of the site's own origins, and `Sec-Fetch-Site`, when
  sent, is `same-origin`. A `POST` must carry an `Origin` and an
  `application/json` body, so another website cannot forge one.
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
  the Host's `rigd`; any other published copy refuses every relay request unless
  it is sandboxed (below), so an unreviewed Branch never holds Host control.

A malformed `RIG_WEB_TRUSTED_CLIENTS` entry stops the server at startup rather
than being skipped or widened. The dashboard also refuses to render inside
another page's frame.

## Signing in from another device

`RIG_WEB_KEY_FILE` (set to `${rig.data}/access.key` in `rig.yaml`) names a file
holding a random access key; the Service creates it, mode 600, on first start and
logs the file's path, never the key. A client that is not loopback or in
`RIG_WEB_TRUSTED_CLIENTS` gets `401 KEY_REQUIRED`, and the dashboard shows a
sign-in form. `POST /api/session` with the key answers a `rig_session` cookie
(`HttpOnly`, `Secure`, `SameSite=Strict`, 30 days) that is an HMAC of its expiry
under the key, so there is no session store: delete the key file and restart the
Service to replace the key and end every session. The host, origin, and tunnel
rules above still apply to a signed-in client.

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
`${rig.data}/rigd`. With it set, `web/server/main.ts` runs `rigd install`
against that root before serving and `rigd uninstall` when the Service stops,
and the relay reads that root instead of `~/.rig`. A Rig root other than
`~/.rig` runs `rigd` as a plain process, never in launchd, with its own token,
state, and Caddyfile (`<root>/proxy/Caddyfile`, never reloaded), so a Preview's
dashboard is fully usable and cannot touch the Host's Projects or routes.

A new sandbox is seeded from `web/demo`: each directory there is copied into the
Preview's data directory, committed, and registered (`web/server/seed.ts`);
`pantry` and `ledger` are deployed and `pantry` also gets a Preview, so every
dashboard screen has something to show. Seeding runs after the site starts
serving, and a Project already present is left alone, so a restart keeps what a
visitor changed. Sandbox Targets get ports but no published URLs. When the
Service stops, the site stops every sandbox Target through the sandbox's control
plane and then runs `rigd uninstall`; `rig down preview <branch> --destroy`
deletes the rest with the Preview's data.

The sandbox isolates state, not privileges: a Project registered in it still
runs its commands as you.

## Layout

| Path                        | Responsibility                                                         |
| --------------------------- | ---------------------------------------------------------------------- |
| `web/site`                  | Static landing page.                                                   |
| `web/theme.css`             | Fonts and the palette tokens both pages share.                         |
| `web/dashboard`             | React app; `api.ts` is its only network code and `types.ts` reuses the |
|                             | control-plane types from `src/`.                                       |
| `web/dashboard/views`       | One file per dashboard screen; `Config.tsx` is the structured editor.  |
| `web/dashboard/config-form` | Pure draft helpers: path edits, the draft-to-patch diff, field help.   |
| `web/dashboard/components`  | shadcn/ui primitives (fetched from the registry, edited in place).     |
| `web/dashboard/styles.css`  | Tailwind entry mapping shadcn tokens onto the Rig palette.             |
| `web/demo`                  | Demo Projects every Preview sandbox is seeded with.                    |
| `web/server`                | `main.ts` (effect owner), `guard.ts` (access policy), `relay.ts`,      |
|                             | `sandbox.ts` (a Preview's own rigd), `seed.ts` (its demo Projects).    |

The dashboard is styled with Tailwind v4 and shadcn/ui. Tailwind compiles
inside Bun's HTML bundler through `bun-plugin-tailwind`, registered in
`bunfig.toml` under `[serve.static]`, so `bun web/server/main.ts` serves the
compiled CSS; the plain `bun build` CLI does not load that plugin. Radix
primitives set inline styles, so the dashboard's Content-Security-Policy allows
`style-src 'unsafe-inline'`; scripts stay `'self'` only.

The config editor never asks for field paths. It holds the parsed `rig.yaml` as
a draft, renders it as forms (Project, Environment, Services, Tools, Proxy,
Targets), and on "Review changes" diffs the draft against what rigd read into
`set`/`remove` edits for `POST /v1/config`. rigd previews them against the
schema, shows the before/after table, and applies with the revision it read. If
`rig.yaml` changed on disk in between, rigd refuses the apply; the dashboard
then reads the file again, keeps the draft, and re-derives the diff against the
newer file for another review. rigd's YAML editor keeps comments: it replaces or
removes a mapping or list only while nothing inside it is commented, so removing
a Service whose block carries comments must be done in an editor.

## Running it

```sh
PORT=4173 bun web/server/main.ts          # against your installed rigd
RIG_ROOT=/tmp/rig-dev/.rig PORT=4173 bun web/server/main.ts   # against an isolated one
```

Then open `http://127.0.0.1:4173/`. To publish it, run `rig init` in this
repository once and `rig deploy live` (or `git push rig main`); DNS for
`rig.b-relay.com` must resolve to this Mac.

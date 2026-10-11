---
status: accepted
---

# A Service may serve a hostname of its own

Melody needs two hostnames on one stable Target: `melody.b-relay.com` for `web` and `api.melody.b-relay.com` for `api`. A Target had exactly one hostname, the Project `domain` (or its role patch), routed by `proxy`. [ADR 0014](0014-rig-owned-caddy.md) (Rig-owned Caddy) made the route request carry a list of sites per Target and left the rig.yaml syntax open; this decides it.

```yaml
domain: melody.b-relay.com
proxy: { /: web }
services:
  api:
    command: ./api --port ${port}
    ports: { http: auto }
    domain: api.melody.b-relay.com # every path of it reaches api's only port
```

- **Syntax.** `services.<name>.domain` is a hostname, or `{ host, port }` where `port` names one of the Service's `ports`. Every path of that hostname reaches that port; there is no path map per hostname. For each Target that is on and serves it, a Service with no port, several ports and no `port`, or a `port` it does not declare is refused at the field with what to write; a role that does not serve the domain is not checked.
- **Same rules as `domain`.** One hostname, `${rig.target}` its only reference, no scheme, port, path, wildcard or list; a label over 63 characters is refused when the Target is planned, never cut short.
- **Per role, like `domain`.** The stable Target serves it as written. A Preview serves the flat form, `api-<preview>.melody.b-relay.com`. The working Target serves one only when `targets.working.services.<name>.domain` sets it. A role patch's `services.<name>.domain` replaces the host for that role; maps merge per key, so a patch that writes `{ host }` keeps an inherited `port`, and a patch that writes a plain hostname drops it.
- **Unique per Target.** No two settings may give one Target the same hostname (the Project domain included, compared without case). Patterns are compared when rig.yaml is read, for every role that is on, and the resolved hostnames again when a Target is planned (`duplicate_hostname`). Collisions with another Target, of any Project, or with an owner route in `proxy.routes` are ADR 0014's one-owner rule: a Service domain is one of its Target's sites, so the deploy's route check and every publication refuse it as `ROUTE_CONFLICT` (hostnames compared bare and without case) and publish none of the Target's hostnames. That now includes a Project's own Targets: with `domain: melody.b-relay.com`, a Service domain `melody-admin.b-relay.com` is also the flat hostname of a Preview named `admin`, and whichever is checked second is refused. Nothing is misrouted, and the flat rule already allowed this between Projects. A `targets.preview` patch replaces the host for every Preview, so it should hold `${rig.target}`, as `targets.preview.domain` should.
- **Independent of `proxy`.** A Service domain needs no `proxy` and no Project `domain`. It does not change the default `/` rule: a Project domain with several Services that have ports still needs `proxy`.
- **Publication.** The plan records `serviceDomains: [{ hostname, service, port }]`, absent when there are none, so a plan recorded before this has no drift. `plannedSites` lists the domain's site and then one site per Service domain, and the Target publishes them as one route block: written, checkpointed, restored and withdrawn together. Withholding is per Service across every hostname, so a Service being started answers 503 on its own hostname while the others keep their upstreams.
- **Reports.** `rig status --json` gains `hostnames` on a Target (its domain first, then each Service domain) and on a Service (the hostnames whose `/` reaches it; `route` is the first), and `serviceDomains` on a recorded Target. The text status lists hostnames beside the Service they reach. `rig doctor` adds a passing `<target>/hostnames` check naming each hostname and its Service. The dashboard shows every hostname on cards, Target headers, the routes panel and the proxy page.

Why per-Service and not a list of hostnames with their own path maps: one hostname per Service is what Melody and the Projects like it need, it reuses the domain rule people already know, and it keeps one `proxy` for the Project domain. A per-hostname path map can still be added later without changing this.

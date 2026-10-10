import type { TargetRole } from "./schema";

/** A Service's `domain` as written: a hostname, or a hostname with the name of the port it reaches. */
export type ServiceDomainSetting = string | { host: string; port?: string };

/** The hostname of a Service's `domain`, in either form. */
export function serviceDomainHost(setting: ServiceDomainSetting): string {
  return typeof setting === "string" ? setting : setting.host;
}

/** A Preview's default hostname: the given hostname with a dash and the Preview name after its first label, so
 * pantry.dev.example.com gives pantry-<preview>.dev.example.com: a sibling of the hostname, not a subdomain of it. */
export function previewDomain(domain: string): string {
  const dot = domain.indexOf(".");
  return dot === -1
    ? `${domain}-\${rig.target}`
    : `${domain.slice(0, dot)}-\${rig.target}${domain.slice(dot)}`;
}

/** One hostname a Target of a role gets from a hostname setting, `${rig.target}` not yet replaced. `patched` says the role's
 * own patch set it, rather than the role's default rule deriving it from the top-level value. */
export interface RoleHostname {
  readonly pattern: string;
  readonly patched: boolean;
}

/** The per-role hostname rule, shared by the Project `domain` and every Service `domain`: a value in the role's own patch
 * wins; otherwise the stable Target serves the top-level value, a Preview its flat form (`previewDomain`), and the working
 * Target none. Undefined when the role gets no hostname from this setting. */
export function roleHostname(
  base: string | undefined,
  patch: string | undefined,
  role: TargetRole,
): RoleHostname | undefined {
  if (patch !== undefined) return { pattern: patch, patched: true };
  if (base === undefined || role === "working") return undefined;
  return {
    pattern: role === "preview" ? previewDomain(base) : base,
    patched: false,
  };
}

/** One Service `domain` a Target of a role serves: its hostname pattern, where it is written and the port name it names. */
export interface RoleServiceDomain extends RoleHostname {
  readonly service: string;
  /** The config path of the setting the hostname comes from: under `targets.<role>` when `patched`. */
  readonly path: string;
  /** The port name the setting names; absent when it names none and the Service's only port is meant. */
  readonly port?: string;
}

type DomainServices = Readonly<
  Record<string, { readonly domain?: ServiceDomainSetting }>
>;

/** Every Service `domain` a Target of `role` serves, in Service order, under the per-role hostname rule (`roleHostname`).
 * `base` is the top-level Services, `patch` the role's patch of them, and `merged` the Services with the patch applied,
 * which decides the port: maps merge per key, so a patch that only changes the host keeps an inherited port, and a
 * patch that writes a plain hostname drops it. */
export function roleServiceDomains(
  base: DomainServices | undefined,
  patch: DomainServices | undefined,
  merged: DomainServices | undefined,
  role: TargetRole,
): RoleServiceDomain[] {
  return Object.entries(merged ?? {}).flatMap(([service, settings]) => {
    const written = patch?.[service]?.domain;
    const original = base?.[service]?.domain;
    const hostname = roleHostname(
      original === undefined ? undefined : serviceDomainHost(original),
      written === undefined ? undefined : serviceDomainHost(written),
      role,
    );
    if (!hostname) return [];
    const port =
      typeof settings.domain === "object" ? settings.domain.port : undefined;
    return [
      {
        ...hostname,
        service,
        path: `${hostname.patched ? `targets.${role}.` : ""}services.${service}.domain`,
        ...(port !== undefined ? { port } : {}),
      },
    ];
  });
}

/** Which port a Service `domain` reaches: the port it names, or the Service's only port. A Service with no port, several
 * ports and no name, or a name it does not declare is refused, with the fix. */
export function serviceDomainPort(
  service: string,
  setting: ServiceDomainSetting,
  ports: Readonly<Record<string, unknown>> | undefined,
): { port: string } | { problem: string } {
  const declared = Object.keys(ports ?? {});
  const host = serviceDomainHost(setting);
  const named = typeof setting === "string" ? undefined : setting.port;
  if (named !== undefined)
    return declared.includes(named)
      ? { port: named }
      : {
          problem: `Service '${service}' has a domain that names the port '${named}', which it does not declare${declared.length ? `; its ports are ${declared.join(", ")}` : ""}.`,
        };
  if (declared.length === 1) return { port: declared[0]! };
  return {
    problem: declared.length
      ? `Service '${service}' has a domain but ${declared.length} ports (${declared.join(", ")}); name the one it reaches, such as domain: { host: ${host}, port: ${declared[0]} }.`
      : `Service '${service}' has a domain but declares no port to route to; declare one, such as ports: { http: auto }, or remove the domain.`,
  };
}

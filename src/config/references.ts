import { createHash } from "node:crypto";
import { ConfigError } from "./errors";
import {
  evaluatingConstruct,
  shellPosition,
  type ShellPosition,
} from "./shell-position";

/** A public env leaf a resolved string was built from, directly or through other leaves. */
export interface PublicInput {
  /** The environment name, such as DATABASE_URL. */
  name: string;
  /** The config path that declares it, such as services.api.environment.DATABASE_URL. */
  source: string;
  value: string;
}
export interface ResolvedText {
  value: string;
  inputs: PublicInput[];
}
/** The values Rig generates for one selected Target; the caller decides them before references resolve. */
export interface GeneratedValues {
  target: string;
  workspace: string;
  host: string;
  url: string;
  /** The Service's recorded persistent directory. */
  data(service: string): string;
  /** The concrete number of a declared port. */
  port(service: string, port: string): number;
}
export interface ReferenceResolver {
  /** Resolves `${...}` in the string declared at config path `at`; that path decides the Service scope. */
  text(value: string, at: string): ResolvedText;
  /** The same for text /bin/sh -c will run, where no value is written into the text: each reference becomes a quoted
   * expansion of a variable named by `shellVariable`, such as "${RIG_REF_...}", whose value the shell never reads as code,
   * and `values` gathers what the variables hold. Refused as `unsafe_reference` in a command with arithmetic, where bash
   * evaluates a variable's value too, and where `shellPosition` refuses. */
  shell(value: string, at: string): ResolvedText;
  /** The variables every `shell` text resolved so far reads, by name. */
  values(): Record<string, string>;
}
/** The variable that carries `value` into a command: named by the value, so a command's text changes only with its values. */
export function shellVariable(value: string): string {
  return `RIG_REF_${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

const REFERENCE = /\$\$\{|\$\{([^}]*)\}/g;
const HINT =
  "A reference names an exact config path such as ${services.web.ports.http} or ${environment.NAME}, a port such as ${port}, ${ports.http} or ${services.web.port}, or a Rig value such as ${rig.target}. Write $${VAR} for a literal shell ${VAR}; $VAR is left to the shell.";
/** A path through a Project's or Service's `env`, which is `environment` now (ADR 0011). */
const RENAMED_ENV = /^((?:services\.[^.]+\.)?)env\.(.+)$/;
const PROJECT_BUILD = /^(?:build|tools\.[^.]+\.build)$/;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Pure recursive resolution over one patched settings graph. A reference is an exact path to a scalar in that graph or a rig.* value;
 * `$${` escapes to a literal `${`. Inside a Service's own settings `${port}` is its only port and `${ports.<port>}` a named one;
 * `${services.<name>.port}` is that Service's only port anywhere. Throws ConfigError `renamed_reference` (a path through the old
 * `env`), `no_port` or `ambiguous_port` (a reference to a Service's only port when it has none or several), `unknown_reference`, `reference_not_scalar`, `reference_into_targets`,
 * `invalid_context` (rig.data, ${port} or ${ports.<port>} outside a Service) or `reference_cycle`, each naming the config path that holds the reference. */
export function referenceResolver(
  settings: Readonly<Record<string, unknown>>,
  generated: GeneratedValues,
): ReferenceResolver {
  const fail = (code: string, message: string, key: string, at: string) =>
    new ConfigError(message, code, { key, path: at }, HINT);
  /** The names of the ports Service `name` declares, or undefined when there is no such Service. */
  const declared = (name: string): string[] | undefined => {
    const services = settings.services;
    if (!isRecord(services) || !Object.hasOwn(services, name)) return undefined;
    const service = services[name];
    const ports = isRecord(service) ? service.ports : undefined;
    return isRecord(ports) ? Object.keys(ports) : [];
  };
  /** `${port}` and `${ports.<port>}` name the ports of the Service whose field holds the text; `${services.<name>.port}`
   * names that Service's only port. Undefined for any other reference. */
  const shortPort = (
    segments: readonly string[],
    at: string,
  ): number | undefined => {
    const key = segments.join(".");
    const short = key === "port" || segments[0] === "ports";
    const named =
      segments.length === 3 &&
      segments[0] === "services" &&
      segments[2] === "port";
    if (!short && !named) return undefined;
    const owner = named ? segments[1]! : /^services\.([^.]+)\./.exec(at)?.[1];
    if (owner === undefined)
      throw fail(
        "invalid_context",
        `\${${key}} in ${at} has no Service; write \${services.<service>.port} or \${services.<service>.ports.<port>}.`,
        key,
        at,
      );
    const ports = declared(owner);
    if (ports === undefined)
      throw fail(
        "unknown_reference",
        `Unknown reference '\${${key}}' in ${at}: '${owner}' is not a declared Service.`,
        key,
        at,
      );
    if (segments[0] === "ports") {
      if (segments.length !== 2 || !ports.includes(segments[1]!))
        throw fail(
          "unknown_reference",
          `Unknown reference '\${${key}}' in ${at}: Service '${owner}' declares ${ports.length ? `the ports ${ports.join(", ")}` : "no ports"}.`,
          key,
          at,
        );
      return generated.port(owner, segments[1]!);
    }
    const longForm = named ? `services.${owner}.ports` : "ports";
    if (ports.length !== 1)
      throw new ConfigError(
        `\${${key}} in ${at} needs one port, but '${owner}' has ${ports.length ? `${ports.length} (${ports.join(", ")}); name one, such as \${${longForm}.${ports[0]}}` : "none; declare one, such as ports: { http: auto }"}.`,
        ports.length ? "ambiguous_port" : "no_port",
        { key, path: at, service: owner, ports },
        ports.length
          ? `Write \${${longForm}.<port>} with one of ${ports.join(", ")}.`
          : `Declare a port on Service '${owner}', such as ports: { http: auto }.`,
      );
    return generated.port(owner, ports[0]!);
  };
  const lookup = (
    key: string,
    at: string,
    stack: readonly string[],
  ): ResolvedText => {
    const renamed = RENAMED_ENV.exec(key);
    if (renamed)
      throw new ConfigError(
        `Reference '\${${key}}' in ${at} names \`env\`, which is now \`environment\`: write \${${renamed[1]}environment.${renamed[2]}}.`,
        "renamed_reference",
        { key, path: at },
        `Write \${${renamed[1]}environment.${renamed[2]}} instead.`,
      );
    // stack[0] is the field being resolved for an invocation; a Project or Tool build has no Service scope, however the value is reached.
    const consumer = stack[0]!;
    if (
      PROJECT_BUILD.test(consumer) &&
      ((key === "rig.data" && at !== consumer) ||
        /^services\.[^.]+\.environment\./.test(key))
    )
      throw fail(
        "invalid_context",
        `${consumer} reaches '\${${key}}'${at === consumer ? "" : ` through ${at}`}: a Project or Tool build runs with Project inputs and cannot use a Service's environment or data.`,
        key,
        at,
      );
    const segments = key.split(".");
    const plain = (value: string | number) => ({
      value: String(value),
      inputs: [],
    });
    if (segments[0] === "rig") {
      // A Service's or job's own fields give it a directory of its own.
      const service = /^(?:services|jobs)\.([^.]+)\./.exec(at)?.[1];
      switch (key) {
        case "rig.target":
          return plain(generated.target);
        case "rig.workspace":
          return plain(generated.workspace);
        case "rig.host":
          return plain(generated.host);
        case "rig.url":
          return plain(generated.url);
        case "rig.data":
          if (service === undefined)
            throw fail(
              "invalid_context",
              `\${rig.data} in ${at} has no Service or job: persistent data belongs to one Service or job. Write \${services.<service>.data} for a Service's directory.`,
              key,
              at,
            );
          return plain(generated.data(service));
      }
      throw fail(
        "unknown_reference",
        `Unknown reference '\${${key}}' in ${at}.`,
        key,
        at,
      );
    }
    const port = shortPort(segments, at);
    if (port !== undefined) return plain(port);
    // `${services.<name>.data}` is that Service's persistent directory, so a job or another Service can share it.
    if (
      segments.length === 3 &&
      segments[0] === "services" &&
      segments[2] === "data"
    ) {
      if (declared(segments[1]!) === undefined)
        throw fail(
          "unknown_reference",
          `Unknown reference '\${${key}}' in ${at}: '${segments[1]}' is not a declared Service.`,
          key,
          at,
        );
      if (PROJECT_BUILD.test(consumer))
        throw fail(
          "invalid_context",
          `${consumer} reaches '\${${key}}'${at === consumer ? "" : ` through ${at}`}: a Project or Tool build runs with Project inputs and cannot use a Service's data.`,
          key,
          at,
        );
      return plain(generated.data(segments[1]!));
    }
    if (segments[0] === "targets")
      throw fail(
        "reference_into_targets",
        `Reference '\${${key}}' in ${at} reaches into targets; a reference reads the selected Target's own settings.`,
        key,
        at,
      );
    if (stack.includes(key))
      throw fail(
        "reference_cycle",
        `References form a cycle: ${[...stack.slice(stack.indexOf(key)), key].join(" -> ")}.`,
        key,
        at,
      );
    let node: unknown = settings;
    for (const segment of segments) {
      if (
        typeof node !== "object" ||
        node === null ||
        Array.isArray(node) ||
        !Object.hasOwn(node, segment)
      )
        throw fail(
          "unknown_reference",
          `Unknown reference '\${${key}}' in ${at}.`,
          key,
          at,
        );
      node = (node as Record<string, unknown>)[segment];
    }
    if (
      segments.length === 4 &&
      segments[0] === "services" &&
      segments[2] === "ports"
    )
      return plain(generated.port(segments[1]!, segments[3]!));
    if (typeof node === "number" || typeof node === "boolean")
      return plain(String(node));
    if (typeof node !== "string")
      throw fail(
        "reference_not_scalar",
        `Reference '\${${key}}' in ${at} names a collection, not one value.`,
        key,
        at,
      );
    const resolved = substitute(node, key, [...stack, key], (value) => value);
    const name =
      /^(?:services\.[^.]+\.)?environment\.([^.]+)$/.exec(key)?.[1] ??
      undefined;
    return name === undefined
      ? resolved
      : {
          value: resolved.value,
          inputs: [
            { name, source: key, value: resolved.value },
            ...resolved.inputs,
          ],
        };
  };
  const substitute = (
    value: string,
    at: string,
    stack: readonly string[],
    render: (result: string, offset: number) => string,
  ): ResolvedText => {
    const inputs = new Map<string, PublicInput>();
    const text = value.replace(
      REFERENCE,
      (_match: string, key: string | undefined, offset: number) => {
        if (key === undefined) return "${";
        const resolved = lookup(key.trim(), at, stack);
        for (const input of resolved.inputs) inputs.set(input.source, input);
        return render(resolved.value, offset);
      },
    );
    return { value: text, inputs: [...inputs.values()] };
  };
  const variables: Record<string, string> = {};
  return {
    text: (value, at) => substitute(value, at, [at], (result) => result),
    shell: (value, at) => {
      const evaluating = evaluatingConstruct(value);
      return substitute(value, at, [at], (result, offset) => {
        const position: ShellPosition = evaluating
          ? {
              kind: "refused",
              place: `in a command with ${evaluating}`,
              hint: 'Read it from environment, such as NAME: ${...}, as "$NAME", and keep it out of arithmetic.',
            }
          : shellPosition(value.slice(0, offset));
        if (position.kind === "refused")
          throw new ConfigError(
            `A reference in ${at} sits ${position.place}, where Rig cannot keep its value literal.`,
            "unsafe_reference",
            { path: at, place: position.place },
            position.hint,
          );
        const name = shellVariable(result);
        variables[name] = result;
        return position.quote === '"'
          ? `\${${name}}`
          : position.quote === "'"
            ? `'"\${${name}}"'`
            : `"\${${name}}"`;
      });
    },
    values: () => ({ ...variables }),
  };
}

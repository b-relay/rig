import { ConfigError } from "./errors";

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
  /** The same for text /bin/sh -c will run. Every substituted value reaches the command as literal data: bare, it is single-quoted when it is empty or would
   * split or expand; inside the author's double or single quotes it is escaped for that quote, so it never closes the quote or runs as shell code. */
  shell(value: string, at: string): ResolvedText;
}

const REFERENCE = /\$\$\{|\$\{([^}]*)\}/g;
const HINT =
  "A reference names an exact config path such as ${services.web.ports.http} or ${environment.NAME}, a port such as ${port}, ${ports.http} or ${services.web.port}, or a Rig value such as ${rig.target}. Write $${VAR} for a literal shell ${VAR}; $VAR is left to the shell.";
/** A path through a Project's or Service's `env`, which is `environment` now (ADR 0011). */
const RENAMED_ENV = /^((?:services\.[^.]+\.)?)env\.(.+)$/;
const PROJECT_BUILD = /^(?:build|tools\.[^.]+\.build)$/;
const shellSafe = /^[A-Za-z0-9_/.:@%+=,-]+$/;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** A value as literal shell data at a position that is bare, inside double quotes, or inside single quotes. */
function shellLiteral(value: string, quote: "'" | '"' | undefined): string {
  if (quote === '"') return value.replace(/[\\"$`]/g, "\\$&");
  const closed = value.replaceAll("'", "'\\''");
  if (quote === "'") return closed;
  return shellSafe.test(value) ? value : `'${closed}'`;
}

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
  return {
    text: (value, at) => substitute(value, at, [at], (result) => result),
    shell: (value, at) =>
      substitute(value, at, [at], (result, offset) => {
        const quote = openShellQuote(value.slice(0, offset));
        if (quote === "`")
          throw new ConfigError(
            `A reference in ${at} sits inside a backquoted command, where Rig cannot keep its value literal.`,
            "invalid_context",
            { path: at },
            "Write the command substitution as $(...) instead of backquotes.",
          );
        return shellLiteral(result, quote);
      }),
  };
}
/** The quoting in force at the end of a prefix of shell text: the open quote of the innermost command, where `$(...)` and `(...)` each start
 * a command of their own with no quote open. "`" means the position is inside a backquoted command, whose escaping rules differ. */
function openShellQuote(prefix: string): "'" | '"' | "`" | undefined {
  // One entry per nested command, innermost last; each holds that command's open quote.
  const commands: ("'" | '"' | undefined)[] = [undefined];
  let backquoted = false;
  for (let i = 0; i < prefix.length; i++) {
    const char = prefix[i];
    const quote = commands.at(-1);
    if (quote === "'") {
      if (char === "'") commands[commands.length - 1] = undefined;
    } else if (char === "\\") i++;
    else if (
      char === "#" &&
      quote === undefined &&
      (i === 0 || /[\s;&|()]/.test(prefix[i - 1]!))
    ) {
      // A comment runs to the end of its line; a quote character in it opens nothing.
      const end = prefix.indexOf("\n", i);
      i = end === -1 ? prefix.length : end;
    } else if (char === "`") backquoted = !backquoted;
    else if (char === "$" && prefix[i + 1] === "(") {
      commands.push(undefined);
      i++;
    } else if (quote === '"') {
      if (char === '"') commands[commands.length - 1] = undefined;
    } else if (char === "'" || char === '"')
      commands[commands.length - 1] = char;
    else if (char === "(") commands.push(undefined);
    else if (char === ")" && commands.length > 1) commands.pop();
  }
  return backquoted ? "`" : commands.at(-1);
}

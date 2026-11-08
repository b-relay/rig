import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  contractBreaches,
  type ContractBreach,
} from "./support/error-contract";

/** Every failure Rig makes is a RigError or a ConfigError, with structured context and a hint of its own (AGENTS.md).
 * This reads the production code under src/ and web/ with the TypeScript checker and refuses, by file and line, any
 * construction or call whose result is an error of another class, any class extending an error that is neither, and any
 * ConfigError whose hint is missing or may be undefined. */

const REPOSITORY = join(import.meta.dir, "..");

/** Files under src/ and web/ that are not Rig's production code, so the contract does not apply to them. */
const EXCLUDED: readonly { matches: (file: string) => boolean; why: string }[] =
  [
    {
      matches: (file) => /\.test\.tsx?$/.test(file),
      why: "Tests, which throw to fail.",
    },
    {
      matches: (file) => file.startsWith("web/demo/"),
      why: "Sample Projects the dashboard's demo mode deploys; they are its users' code, not Rig's.",
    },
    {
      matches: (file) => file === "web/postcss.config.mjs",
      why: "Build tooling for the dashboard's CSS.",
    },
  ];
const excluded = (file: string) =>
  EXCLUDED.some(({ matches }) => matches(file));

/** Errors of another class that never leave the code that makes them, each with what catches or reads it. An entry names
 * its file and the error's class, or its literal message or expression text, and `count` is how many breaches it matches
 * there: one more, even beside it, is refused. */
const SENTINELS: readonly (Pick<ContractBreach, "file"> &
  Partial<Pick<ContractBreach, "error" | "text">> & {
    count: number;
    why: string;
  })[] = [
  {
    file: "src/providers/caddy-binary.ts",
    count: 1,
    text: "not a file",
    why: "The catch around it throws PROXY_BINARY, naming proxy.caddy.",
  },
  {
    file: "src/daemon/composition.ts",
    count: 1,
    text: "the configuration it serves is an older rigd's, which does not say which of proxy.routes is a dashboard's; it is replaced once rig proxy reload publishes Host config",
    why: "takeOverDashboard catches it and puts the reason in the dashboard notice; it is a clause of that sentence.",
  },
  {
    file: "src/daemon/composition.ts",
    count: 1,
    text: "new Error(String(error))",
    why: "An unreadable Host config, which proxyReport takes as a value and reports; never thrown.",
  },
  {
    file: "src/runtime/doctor.ts",
    count: 1,
    text: "new Error(String(error))",
    why: "An unreadable config document, which doctor takes as a value and reports; never thrown.",
  },
  {
    file: "src/diagnostics/file-log.ts",
    count: 1,
    text: "Diagnostic writer is busy.",
    why: "createFileDiagnosticLog catches every sink failure and returns its result instead; #424 gives that result structured evidence.",
  },
  {
    file: "src/diagnostics/file-log.ts",
    count: 1,
    text: "Diagnostic log is not a file.",
    why: "As above: caught by createFileDiagnosticLog, #424.",
  },
  {
    file: "src/diagnostics/file-log.ts",
    count: 1,
    text: "Diagnostic archive identity conflict.",
    why: "As above: caught by createFileDiagnosticLog, #424.",
  },
  {
    file: "src/providers/managed-caddy.ts",
    count: 2,
    error: "DashboardRouteChanged",
    why: "Thrown by activation before anything is loaded; its callers catch it and build the generation again.",
  },
  {
    file: "src/runtime/application.ts",
    count: 3,
    error: "Reselect",
    why: "The Operation selects again: isReselect catches it, and after the last try admission gives OPERATION_CONTENDED.",
  },
  {
    file: "src/adapters/proxy-verify.ts",
    count: 1,
    text: "checkServerIdentity(hostname, certificate)",
    why: "Node's answer for a certificate, only compared with undefined; never thrown.",
  },
  {
    file: "src/cli/commands.ts",
    count: 2,
    error: "InvalidArgumentError",
    why: "Commander catches it from an option's parser and reports it as a usage error.",
  },
  {
    file: "src/cli/dns-command.ts",
    count: 3,
    error: "InvalidArgumentError",
    why: "As above: Commander's usage error.",
  },
];

const allowedBy = (
  sentinel: (typeof SENTINELS)[number],
  breach: ContractBreach,
) =>
  breach.rule !== "config-error-hint" &&
  sentinel.file === breach.file &&
  (sentinel.error === undefined || sentinel.error === breach.error) &&
  (sentinel.text === undefined || sentinel.text === breach.text);
const located = (breach: ContractBreach) =>
  `${breach.file}:${breach.line} ${breach.rule} ${breach.error}: ${breach.text}`;

let repository: ReturnType<typeof contractBreaches> | undefined;
const repositoryBreaches = () =>
  (repository ??= contractBreaches(REPOSITORY, excluded));

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("production code makes only tagged errors and gives every ConfigError its own hint", async () => {
  const { breaches } = await repositoryBreaches();
  expect(
    breaches
      .filter((breach) => !SENTINELS.some((s) => allowedBy(s, breach)))
      .map(located),
  ).toEqual([]);
}, 60_000);

test("every allowed sentinel is made exactly as often as its entry says, so the list neither grows unseen nor outlives its code", async () => {
  const { breaches } = await repositoryBreaches();
  for (const sentinel of SENTINELS) {
    const matched = breaches.filter((breach) => allowedBy(sentinel, breach));
    // A wrong count shows where each match is.
    expect({
      sentinel,
      count: matched.length,
      at: matched.map(located),
    }).toMatchObject({ sentinel, count: sentinel.count });
  }
}, 60_000);

test("every tracked source file under src/ and web/ is read, or excluded with its reason", async () => {
  const { files } = await repositoryBreaches();
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", "src", "web"], {
    cwd: REPOSITORY,
  });
  expect(listed.exitCode).toBe(0);
  const tracked = listed.stdout
    .toString()
    .split("\0")
    .filter((file) => /\.(ts|tsx|js|mjs)$/.test(file));
  expect(tracked).toContain("src/domain/errors.ts");
  expect(tracked).toContain("web/components/config-editor.tsx");
  const read = new Set(files);
  expect(tracked.filter((file) => !read.has(file) && !excluded(file))).toEqual(
    [],
  );
  // An exclusion is never read, so a file both read and excluded would mean the exclusion was ignored.
  expect(files.filter(excluded)).toEqual([]);
}, 60_000);

/** A project laid out as Rig is, with the contract's classes at their paths. */
const CONTRACT_FILES: Record<string, string> = {
  "src/domain/errors.ts": [
    "export class RigError extends Error {",
    '  readonly _tag = "RigError";',
    "  constructor(readonly code: string, message: string, readonly hint: string) {",
    "    super(message);",
    "  }",
    "}",
  ].join("\n"),
  "src/config/errors.ts": [
    "export class ConfigError extends Error {",
    '  readonly _tag = "ConfigError";',
    "  constructor(",
    "    message: string,",
    "    readonly code: string,",
    "    readonly context: Readonly<Record<string, unknown>> = {},",
    '    readonly hint = "Fix the indicated config document and retry.",',
    "  ) {",
    "    super(message);",
    "  }",
    "}",
  ].join("\n"),
};

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rig-error-contract-"));
  roots.push(root);
  const options = { strict: true, target: "ESNext", module: "ESNext" };
  const all: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: options,
      include: ["src"],
    }),
    "web/tsconfig.json": JSON.stringify({
      compilerOptions: options,
      include: ["**/*.ts", "**/*.tsx"],
    }),
    ...CONTRACT_FILES,
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

test("an error of another class is refused at its line however it is named, made or held", async () => {
  const root = await project({
    "src/added.ts": [
      'import { RigError } from "./domain/errors";',
      '// throw new Error("in a comment") is not code.',
      'export const text = "throw new Error(\\"in a string\\")";',
      "const E = Error;",
      "export class Failure extends Error {}",
      "export const Plain = Error;",
      "export function added(kind: number) {",
      '  if (kind === 1) throw new Error("plain");',
      "  if (kind === 2) throw TypeError(`called`);",
      '  if (kind === 3) throw new E("aliased");',
      '  if (kind === 4) throw (new Error("parenthesized"));',
      '  if (kind === 5) throw new Failure("subclass");',
      '  if (kind === 6) throw new globalThis["Error"]("dynamic");',
      '  const held = new Error("held");',
      "  if (kind === 7) throw held;",
      '  if (kind === 8) throw Object.assign(new E("assigned"), { code: "X" });',
      '  if (kind === 9) throw new RigError("TAGGED", "tagged", "Fix it.");',
      "}",
      "/** Not errors: an object with a name and a message, and a failure that may be absent. */",
      'export const lookalike = () => ({ name: "check", message: "fine" });',
      "export const maybe = (): RigError | undefined => undefined;",
      "lookalike();",
      "maybe();",
      "// Shaped like a ConfigError, but asRigError's instanceof refuses it.",
      'export class Fake extends Error { readonly _tag = "ConfigError"; readonly code = "invalid_config"; readonly context = {}; readonly hint = "Fix it."; }',
      'export const faked = new Fake("lookalike tag");',
    ].join("\n"),
    "src/reexported.ts": [
      'export { Plain as Exported } from "./added";',
      'import { Exported } from "./reexported";',
      'export const made = new Exported("re-exported");',
    ].join("\n"),
    "web/components/added.tsx": [
      "export function Added() {",
      '  throw new Error("in the dashboard");',
      "}",
    ].join("\n"),
    // Tests and excluded files are not read.
    "src/added.test.ts": 'throw new Error("in a test");\n',
    "web/demo/app.ts": 'throw new Error("in a demo");\n',
  });
  const { files, breaches } = await contractBreaches(root, excluded);
  expect(files).toEqual([
    "src/added.ts",
    "src/config/errors.ts",
    "src/domain/errors.ts",
    "src/reexported.ts",
    "web/components/added.tsx",
  ]);
  expect(breaches.map(located)).toEqual([
    "src/added.ts:5 untagged-error-class Failure: Failure",
    "src/added.ts:8 untagged-error Error: plain",
    "src/added.ts:9 untagged-error TypeError: called",
    "src/added.ts:10 untagged-error Error: aliased",
    "src/added.ts:11 untagged-error Error: parenthesized",
    "src/added.ts:12 untagged-error Failure: subclass",
    "src/added.ts:13 untagged-error Error: dynamic",
    "src/added.ts:14 untagged-error Error: held",
    'src/added.ts:16 untagged-error Error: Object.assign(new E("assigned"), { code: "X" })',
    "src/added.ts:16 untagged-error Error: assigned",
    "src/added.ts:25 untagged-error-class Fake: Fake",
    "src/added.ts:26 untagged-error Fake: lookalike tag",
    "src/reexported.ts:3 untagged-error Error: re-exported",
    "web/components/added.tsx:2 untagged-error Error: in the dashboard",
  ]);
}, 60_000);

test("a ConfigError whose hint is missing or may be undefined is refused under any name, and one with a hint is not", async () => {
  const root = await project({
    "src/hints.ts": [
      'import { ConfigError } from "./config/errors";',
      'import { ConfigError as CE } from "./config/errors";',
      "export const maybe = (hint?: string) => [",
      '  new ConfigError("hintless", "invalid_config"),',
      '  new ConfigError("undefined", "invalid_config", {}, undefined),',
      '  new ConfigError("optional", "invalid_config", {}, hint),',
      '  new CE("aliased", "invalid_config"),',
      '  new ConfigError("hinted", "invalid_config", {}, "Fix it."),',
      '  new CE("aliased and hinted", "invalid_config", {}, `Fix ${hint ?? "it"}.`),',
      "];",
      "export class Narrow extends ConfigError {",
      "  constructor() {",
      '    super("narrowed", "invalid_config");',
      "  }",
      "}",
      "// These inherit ConfigError's constructor, directly and through a parent.",
      "export class Inherited extends ConfigError {}",
      "export class Grandchild extends Inherited {}",
      "export const inherited = [",
      '  new Inherited("inherited", "invalid_config"),',
      '  new Grandchild("grandchild", "invalid_config", {}, undefined),',
      '  new Grandchild("inherited and hinted", "invalid_config", {}, "Fix it."),',
      "];",
    ].join("\n"),
  });
  expect(
    (await contractBreaches(root, excluded)).breaches.map(located),
  ).toEqual([
    "src/hints.ts:4 config-error-hint ConfigError: hintless",
    "src/hints.ts:5 config-error-hint ConfigError: undefined",
    "src/hints.ts:6 config-error-hint ConfigError: optional",
    "src/hints.ts:7 config-error-hint ConfigError: aliased",
    "src/hints.ts:13 config-error-hint ConfigError: narrowed",
    "src/hints.ts:20 config-error-hint ConfigError: inherited",
    "src/hints.ts:21 config-error-hint ConfigError: grandchild",
  ]);
}, 60_000);

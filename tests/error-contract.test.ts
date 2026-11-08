import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  contractBreaches,
  type ContractBreach,
} from "./support/error-contract";

/** Every failure Rig lets escape is a tagged error with structured context and its own hint (AGENTS.md). This reads the
 * production code under src/ and web/ through the TypeScript AST and refuses, by file and line: a thrown built-in
 * Error or TypeError, an `Object.assign(new Error(...), ...)`, and a ConfigError left with the generic default hint. */

const REPOSITORY = join(import.meta.dir, "..");

/** Plain errors that never leave the code that throws them. Each is named by its file and message, so a new plain throw
 * beside one is still refused, and each says who catches it. */
const SENTINELS: readonly (Pick<ContractBreach, "file" | "message"> & {
  why: string;
})[] = [
  {
    file: "src/providers/caddy-binary.ts",
    message: "not a file",
    why: "The catch around it throws PROXY_BINARY, naming proxy.caddy.",
  },
  {
    file: "src/daemon/composition.ts",
    message:
      "the configuration it serves is an older rigd's, which does not say which of proxy.routes is a dashboard's; it is replaced once rig proxy reload publishes Host config",
    why: "takeOverDashboard catches it and puts the reason in the dashboard notice; it is a clause of that sentence.",
  },
  {
    file: "src/diagnostics/file-log.ts",
    message: "Diagnostic writer is busy.",
    why: "createFileDiagnosticLog catches every sink failure and returns its result instead; #424 gives that result structured evidence.",
  },
  {
    file: "src/diagnostics/file-log.ts",
    message: "Diagnostic log is not a file.",
    why: "As above: caught by createFileDiagnosticLog, #424.",
  },
  {
    file: "src/diagnostics/file-log.ts",
    message: "Diagnostic archive identity conflict.",
    why: "As above: caught by createFileDiagnosticLog, #424.",
  },
];

const allowed = (breach: ContractBreach) =>
  SENTINELS.some(
    (sentinel) =>
      breach.rule === "plain-throw" &&
      sentinel.file === breach.file &&
      sentinel.message === breach.message,
  );
const located = (breach: ContractBreach) =>
  `${breach.file}:${breach.line} ${breach.rule}${breach.message === undefined ? "" : ` (${breach.message})`}`;

let repository: ReturnType<typeof contractBreaches> | undefined;
const repositoryBreaches = () => (repository ??= contractBreaches(REPOSITORY));

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("production code throws only tagged errors and gives every ConfigError its own hint", async () => {
  const { files, breaches } = await repositoryBreaches();
  // Both projects were read, so a check that found nothing did look.
  expect(files).toContain("src/domain/errors.ts");
  expect(files).toContain("web/components/config-editor.tsx");
  expect(files.some((file) => file.endsWith(".test.ts"))).toBe(false);
  expect(breaches.filter((breach) => !allowed(breach)).map(located)).toEqual(
    [],
  );
}, 60_000);

test("every allowed sentinel is still thrown where it is named, so the list does not outlive its code", async () => {
  const { breaches } = await repositoryBreaches();
  for (const sentinel of SENTINELS)
    expect({
      sentinel,
      found: breaches.filter(
        (breach) =>
          breach.file === sentinel.file && breach.message === sentinel.message,
      ).length,
    }).toEqual({ sentinel, found: 1 });
}, 60_000);

test("a plain throw, an assigned Error and a hintless ConfigError added under src/ or web/ are refused at their lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-error-contract-"));
  roots.push(root);
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ include: ["src"] }),
    "web/tsconfig.json": JSON.stringify({ include: ["**/*.ts", "**/*.tsx"] }),
    "src/config/errors.ts": "export class ConfigError extends Error {}\n",
    "src/added.ts": [
      'import { ConfigError } from "./config/errors";',
      '// throw new Error("in a comment") is not code.',
      'const text = "throw new Error(\\"in a string\\")";',
      "export function added(kind: number) {",
      '  if (kind === 1) throw new Error("plain");',
      "  if (kind === 2) throw TypeError(`called`);",
      "  if (kind === 3)",
      '    throw Object.assign(new Error("assigned"), { code: "X" });',
      '  if (kind === 4) throw new ConfigError("hintless", "invalid_config", {});',
      '  if (kind === 5) throw new ConfigError("hinted", "invalid_config", {}, "Fix it.");',
      "  return text;",
      "}",
    ].join("\n"),
    "web/components/added.tsx": [
      "export function Added() {",
      '  throw new Error("in the dashboard");',
      "}",
    ].join("\n"),
    // Tests are not production code.
    "src/added.test.ts": 'throw new Error("in a test");\n',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const { files: read, breaches } = await contractBreaches(root);
  expect(read).toEqual([
    "src/added.ts",
    "src/config/errors.ts",
    "web/components/added.tsx",
  ]);
  expect(breaches.map(located)).toEqual([
    "src/added.ts:5 plain-throw (plain)",
    "src/added.ts:6 plain-throw (called)",
    "src/added.ts:8 assigned-error (assigned)",
    "src/added.ts:9 config-error-hint (hintless)",
    "web/components/added.tsx:2 plain-throw (in the dashboard)",
  ]);
}, 60_000);

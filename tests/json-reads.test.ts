import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { uncheckedJsonReads, type UncheckedRead } from "./support/json-reads";
import { excluded, trackedSourceFiles } from "./support/production-files";

/** External JSON is checked before it is used (AGENTS.md: validate external input with Zod). This reads the production code
 * under src/ and web/ with the TypeScript checker and refuses, by file and line, any `JSON.parse(...)` or `.json()` whose
 * value is cast, held untyped or typed, or used before it reaches a place typed `unknown`: a Zod schema's parse, a hand
 * check's parameter, or a variable, field or return declared `unknown`. */

const REPOSITORY = join(import.meta.dir, "..");

/** Reads of JSON Rig wrote itself a moment before, in the same code, so there is nothing external to check. An entry names its
 * file and the expression the value reaches, and `count` is how many unchecked reads it matches there: one more, even beside
 * it, is refused. */
const ROUND_TRIPS: readonly (Pick<UncheckedRead, "file" | "text"> & {
  count: number;
  why: string;
})[] = [
  {
    file: "src/runtime/state-store.ts",
    count: 1,
    text: "JSON.parse(JSON.stringify(state)) as RuntimeState",
    why: "A copy of the runtime state this write holds, for one change of several; schema.parse checks the copy after the change.",
  },
  {
    file: "web/components/config-editor.tsx",
    count: 1,
    text: "JSON.parse(patchText) as ConfigPatch[]",
    why: "patchText is JSON.stringify(patch) of the editor's own patch, kept as text so the check runs again only when it changes.",
  },
  {
    file: "web/components/log-viewer.tsx",
    count: 1,
    text: "JSON.parse(filter) as ReturnType<typeof logFilter> | null",
    why: "filter is JSON.stringify(logFilter(query) ?? null) in the same component, kept as text so the follow restarts only when it changes.",
  },
  {
    file: "web/components/log-viewer.tsx",
    count: 1,
    text: "JSON.parse(selector) as ReturnType<typeof targetSelector>",
    why: "As above: selector is JSON.stringify(targetSelector(target)).",
  },
];

const allowedBy = (trip: (typeof ROUND_TRIPS)[number], read: UncheckedRead) =>
  trip.file === read.file && trip.text === read.text;
const located = (read: UncheckedRead) =>
  `${read.file}:${read.line} ${read.read}: ${read.text}`;

let repository: ReturnType<typeof uncheckedJsonReads> | undefined;
const repositoryReads = () =>
  (repository ??= uncheckedJsonReads(REPOSITORY, excluded));

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("production code checks every external JSON read before it uses the value", async () => {
  const { reads } = await repositoryReads();
  expect(
    reads
      .filter((read) => !ROUND_TRIPS.some((trip) => allowedBy(trip, read)))
      .map(located),
  ).toEqual([]);
}, 60_000);

test("every allowed round trip is read exactly as often as its entry says, so the list neither grows unseen nor outlives its code", async () => {
  const { reads } = await repositoryReads();
  for (const trip of ROUND_TRIPS) {
    const matched = reads.filter((read) => allowedBy(trip, read));
    // A wrong count shows where each match is.
    expect({
      trip,
      count: matched.length,
      at: matched.map(located),
    }).toMatchObject({ trip, count: trip.count });
  }
}, 60_000);

test("every tracked source file under src/ and web/ is read, or excluded with its reason", async () => {
  const { files } = await repositoryReads();
  const tracked = trackedSourceFiles(REPOSITORY);
  expect(tracked).toContain("src/providers/proxy-records.ts");
  expect(tracked).toContain("web/components/log-viewer.tsx");
  const read = new Set(files);
  expect(tracked.filter((file) => !read.has(file) && !excluded(file))).toEqual(
    [],
  );
  expect(files.filter(excluded)).toEqual([]);
}, 60_000);

/** A project laid out as Rig is, with the repository's own packages, so Zod and the DOM's and Bun's types resolve. */
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rig-json-reads-"));
  roots.push(root);
  const options = {
    strict: true,
    target: "ESNext",
    module: "ESNext",
    moduleResolution: "bundler",
    skipLibCheck: true,
  };
  const all: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { ...options, types: ["bun-types"] },
      include: ["src"],
    }),
    "web/tsconfig.json": JSON.stringify({
      compilerOptions: {
        ...options,
        lib: ["dom", "esnext"],
        jsx: "react-jsx",
        types: [],
      },
      include: ["**/*.ts", "**/*.tsx"],
    }),
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await symlink(join(REPOSITORY, "node_modules"), join(root, "node_modules"));
  return root;
}

test("an external JSON read that is cast, held or used before a check is refused at its line, and a checked one is not", async () => {
  const root = await project({
    "src/reads.ts": [
      'import { z } from "zod";',
      'import * as mini from "zod/mini";',
      "interface Foo { a: number }",
      "const schema = z.object({ a: z.number() });",
      "const small = mini.object({ a: mini.number() });",
      "const take = (foo: Foo) => foo.a;",
      'const isFoo = (value: unknown): value is Foo => typeof value === "object" && value !== null && "a" in value;',
      "export async function unchecked(text: string, response: Response, path: string) {",
      "  const cast = JSON.parse(text) as Foo;",
      "  const typed: Foo = JSON.parse(text);",
      "  const untyped = JSON.parse(text);",
      "  const field = JSON.parse(text).a;",
      "  const passed = take(JSON.parse(text));",
      "  const fetched = (await response.json()) as Foo;",
      "  const chained = await response.json().then((body) => body.a);",
      "  const fallback = await response.json().catch(() => undefined);",
      "  const file = (await Bun.file(path).json()) as Foo;",
      "  const parenthesized = (JSON.parse(text)!) as Foo;",
      "  return [cast, typed, untyped, field, passed, fetched, chained, fallback, file, parenthesized];",
      "}",
      "export async function checked(text: string, response: Response) {",
      "  const parsed = schema.parse(JSON.parse(text));",
      "  const safe = small.safeParse(await response.json());",
      "  const functional = z.parse(schema, JSON.parse(text));",
      "  const hand = isFoo(JSON.parse(text));",
      "  const held: unknown = JSON.parse(text);",
      "  const opaque = JSON.parse(text) as unknown;",
      "  const caught: unknown = await response.json().catch(() => undefined);",
      "  const then = await response.json().then((body: unknown) => ({ body }));",
      "  const field: { value: unknown } = { value: JSON.parse(text) };",
      "  return [parsed, safe, functional, hand, held, opaque, caught, then, field];",
      "}",
      "export const returned = (text: string): unknown => JSON.parse(text);",
      "// JSON.parse(text) as Foo in a comment, and parses that are not JSON reads.",
      'export const others = [Date.parse("2026-01-01"), schema.parse({ a: 1 }), Response.json({ a: 1 })];',
    ].join("\n"),
    // A member of a union, and a member called through parentheses.
    "src/forms.ts": [
      "export async function union(body: Response | Blob) { return (await body.json()).a; }",
      "export function parse(text: string) { return (JSON.parse)(text).a; }",
      "export async function bodyParens(body: Response) { return (await (body.json)()).a; }",
      "export async function checkedUnion(body: Response | Blob): Promise<unknown> { const value: unknown = await body.json(); return value; }",
      "export function checkedParse(text: string): unknown { return (JSON.parse)(text); }",
      "export async function checkedParens(body: Response) { const value: unknown = await (body.json)(); return value; }",
      "export async function notABody(source: Response | { json(): Promise<number> }) { return (await source.json()) as number; }",
    ].join("\n"),
    "web/components/reads.tsx": [
      "export async function Reads(response: Response) {",
      '  return [(await response.json()) as { a: number }, JSON.parse("{}") as object];',
      "}",
    ].join("\n"),
    // Tests and excluded files are not read.
    "src/reads.test.ts": 'export const read = JSON.parse("{}") as object;\n',
    "web/demo/app.ts": 'export const read = JSON.parse("{}") as object;\n',
  });
  const { files, reads } = await uncheckedJsonReads(root, excluded);
  expect(files).toEqual([
    "src/forms.ts",
    "src/reads.ts",
    "web/components/reads.tsx",
  ]);
  expect(reads.map(located)).toEqual([
    "src/forms.ts:1 .json(): (await body.json())",
    "src/forms.ts:2 JSON.parse: (JSON.parse)(text)",
    "src/forms.ts:3 .json(): (await (body.json)())",
    "src/forms.ts:7 .json(): (await source.json()) as number",
    "src/reads.ts:9 JSON.parse: JSON.parse(text) as Foo",
    "src/reads.ts:10 JSON.parse: JSON.parse(text)",
    "src/reads.ts:11 JSON.parse: JSON.parse(text)",
    "src/reads.ts:12 JSON.parse: JSON.parse(text)",
    "src/reads.ts:13 JSON.parse: JSON.parse(text)",
    "src/reads.ts:14 .json(): (await response.json()) as Foo",
    "src/reads.ts:15 .json(): response.json().then((body) => body.a)",
    "src/reads.ts:16 .json(): await response.json().catch(() => undefined)",
    "src/reads.ts:17 .json(): (await Bun.file(path).json()) as Foo",
    "src/reads.ts:18 JSON.parse: (JSON.parse(text)!) as Foo",
    "web/components/reads.tsx:2 .json(): (await response.json()) as { a: number }",
    'web/components/reads.tsx:2 JSON.parse: JSON.parse("{}") as object',
  ]);
}, 60_000);

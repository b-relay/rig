import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { DotenvLoader } from "./dotenv-loader.js"
import { NodeFileSystem } from "./node-fs.js"
import { EnvLoaderError } from "../schema/errors.js"

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

let tmpDir: string
let loader: DotenvLoader

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "rig-dotenv-loader-test-"))
  loader = new DotenvLoader(new NodeFileSystem())
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

const writeEnvFile = async (name: string, content: string): Promise<string> => {
  const path = join(tmpDir, name)
  await writeFile(path, content, "utf-8")
  return path
}

const loadEither = (envFile: string, workdir: string = tmpDir) =>
  run(loader.load(envFile, workdir).pipe(Effect.either))

describe("DotenvLoader", () => {
  test("parses basic KEY=VALUE entries including single-character key/value", async () => {
    await writeEnvFile(".env", "FOO=bar\nK=V\n")

    const parsed = await run(loader.load(".env", tmpDir))
    expect(parsed).toEqual({
      FOO: "bar",
      K: "V",
    })
  })

  test("skips comments, blank lines, and whitespace-only lines", async () => {
    await writeEnvFile(
      ".env",
      "# top comment\n\nFOO=bar\n   \n\t\n# middle comment\nBAR=baz\n",
    )

    const parsed = await run(loader.load(".env", tmpDir))
    expect(parsed).toEqual({
      FOO: "bar",
      BAR: "baz",
    })
  })

  test("supports export prefix including extra spaces", async () => {
    await writeEnvFile(".env", "export FOO=bar\nexport  BAR = baz\nexport\tBAZ=qux\n")

    const parsed = await run(loader.load(".env", tmpDir))
    expect(parsed).toEqual({
      FOO: "bar",
      BAR: "baz",
      BAZ: "qux",
    })
  })

  test("parses double-quoted values and decodes supported escape sequences", async () => {
    await writeEnvFile(
      ".env",
      'MULTILINE="line1\\nline2"\nRETURN="a\\rb"\nTAB="x\\ty"\nQUOTE="say \\"hi\\""\n',
    )

    const parsed = await run(loader.load(".env", tmpDir))
    expect(parsed).toEqual({
      MULTILINE: "line1\nline2",
      RETURN: "a\rb",
      TAB: "x\ty",
      QUOTE: 'say "hi"',
    })
  })

  test("parses single-quoted values without escape processing", async () => {
    await writeEnvFile(".env", "RAW='line1\\nline2'\nTABS='x\\ty'\n")

    const parsed = await run(loader.load(".env", tmpDir))
    expect(parsed).toEqual({
      RAW: "line1\\nline2",
      TABS: "x\\ty",
    })
  })

  test("supports inline comments on unquoted values", async () => {
    await writeEnvFile(
      ".env",
      "A=value # comment\nB=value#not-a-comment\nC=value   # another\nD=plain\t# tab comment\n",
    )

    const parsed = await run(loader.load(".env", tmpDir))
    expect(parsed).toEqual({
      A: "value",
      B: "value#not-a-comment",
      C: "value",
      D: "plain",
    })
  })

  test("does not strip # inside quoted values", async () => {
    await writeEnvFile(".env", 'A="hello # world"\nB=\'hello # world\'\n')

    const parsed = await run(loader.load(".env", tmpDir))
    expect(parsed).toEqual({
      A: "hello # world",
      B: "hello # world",
    })
  })

  test("trims spaces around keys and = separator", async () => {
    await writeEnvFile(".env", "  FOO   =   bar\n")

    const parsed = await run(loader.load(".env", tmpDir))
    expect(parsed).toEqual({
      FOO: "bar",
    })
  })

  test("supports values that are only quotes", async () => {
    await writeEnvFile(".env", 'EMPTY_DOUBLE=""\nEMPTY_SINGLE=\'\'\n')

    const parsed = await run(loader.load(".env", tmpDir))
    expect(parsed).toEqual({
      EMPTY_DOUBLE: "",
      EMPTY_SINGLE: "",
    })
  })

  test("returns EnvLoaderError for invalid key names", async () => {
    await writeEnvFile(".env", "1INVALID=value\n")

    const result = await loadEither(".env")
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(EnvLoaderError)
      expect(result.left.message).toContain("Invalid key")
    }
  })

  test("returns EnvLoaderError when '=' separator is missing", async () => {
    await writeEnvFile(".env", "MALFORMED_LINE\n")

    const result = await loadEither(".env")
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(EnvLoaderError)
      expect(result.left.message).toContain("expected KEY=VALUE")
    }
  })

  test("returns EnvLoaderError for unterminated quoted values", async () => {
    await writeEnvFile(".env", 'BAD_DOUBLE="\n')
    const doubleResult = await loadEither(".env")
    expect(doubleResult._tag).toBe("Left")
    if (doubleResult._tag === "Left") {
      expect(doubleResult.left).toBeInstanceOf(EnvLoaderError)
      expect(doubleResult.left.message).toContain("Unterminated double-quoted value")
    }

    await writeEnvFile(".env", "BAD_SINGLE='\n")
    const singleResult = await loadEither(".env")
    expect(singleResult._tag).toBe("Left")
    if (singleResult._tag === "Left") {
      expect(singleResult.left).toBeInstanceOf(EnvLoaderError)
      expect(singleResult.left.message).toContain("Unterminated single-quoted value")
    }
  })

  test("resolves relative env paths against workdir and accepts absolute env paths", async () => {
    const absoluteEnvPath = await writeEnvFile("absolute.env", "ABS=absolute\n")
    await writeEnvFile(".env", "REL=relative\n")

    const relativeParsed = await run(loader.load(".env", tmpDir))
    const absoluteParsed = await run(loader.load(absoluteEnvPath, "/workdir/should/not/matter"))

    expect(relativeParsed).toEqual({ REL: "relative" })
    expect(absoluteParsed).toEqual({ ABS: "absolute" })
  })

  test("maps missing file errors to EnvLoaderError", async () => {
    const missing = "does-not-exist.env"
    const result = await loadEither(missing)

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(EnvLoaderError)
      expect(result.left.envFile).toBe(join(tmpDir, missing))
    }
  })

  test("returns an empty object for an empty file", async () => {
    await writeEnvFile(".env", "")

    const parsed = await run(loader.load(".env", tmpDir))
    expect(parsed).toEqual({})
  })

  test("parses mixed valid entries correctly", async () => {
    await writeEnvFile(
      ".env",
      [
        "# comment",
        "export API_KEY=abc123",
        "PORT = 3000",
        'HOST="hello # world"',
        "RAW='line1\\nline2'",
        "TOKEN=token-value # inline comment",
        "K=V",
        'EMPTY=""',
      ].join("\n"),
    )

    const parsed = await run(loader.load(".env", tmpDir))
    expect(parsed).toEqual({
      API_KEY: "abc123",
      PORT: "3000",
      HOST: "hello # world",
      RAW: "line1\\nline2",
      TOKEN: "token-value",
      K: "V",
      EMPTY: "",
    })
  })
})

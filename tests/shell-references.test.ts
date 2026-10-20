import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectConfig } from "../src/config";
import { referenceResolver } from "../src/config/references";

/** Text that runs a command, expands a variable or closes a quote if the shell ever reads it as code. Each command it could
 * run leaves a file behind in the directory the command runs in. */
const HOSTILE = "$(touch ran-dollar) `touch ran-backquote` $HOME ' \" \\ ;x";
/** An array subscript, whose command runs when bash evaluates the text as arithmetic or as a variable name. */
const INDEX = "b[$(touch ran-index)]";
const WORKSPACE = "/repos/ws$(touch ran-workspace)";
const environment = {
  VALUE: HOSTILE,
  INDEX,
  NAME: "INDEX",
  PORT: "4000",
  BRACE: "a,b",
  RANGE: "1..3",
  USER_NAME: "root",
};
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
/** `command` resolved as Rig resolves a shell field: its text, and the variables that carry its values. */
function resolve(command: string) {
  const references = referenceResolver(
    { environment, services: { web: { command: "serve" } } },
    {
      target: "working",
      workspace: WORKSPACE,
      host: "",
      url: "",
      data: () => "/data",
      port: () => 4000,
    },
  );
  const text = references.shell(command, "build").value;
  return { text, values: references.values() };
}
/** What /bin/sh -c prints for `text` in an empty directory, with the environment a Service gets, and the files it left. */
async function sh(text: string, values: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "rig-shell-ref-"));
  roots.push(directory);
  const result = Bun.spawnSync(["/bin/sh", "-c", text], {
    cwd: directory,
    env: {
      PATH: process.env.PATH!,
      HOME: "/home/expanded",
      ...environment,
      ...values,
    },
  });
  return {
    stdout: result.stdout.toString(),
    files: await readdir(directory),
  };
}
/** `command` resolved and run as Rig runs it. */
async function run(command: string) {
  const { text, values } = resolve(command);
  return await sh(text, values);
}

test("a reference reaches the command as a quoted variable that carries its value, never as text", () => {
  const { text, values } = resolve(
    "printf '%s\\n' ${environment.VALUE} \"${rig.workspace}/x\" 'at ${rig.workspace}'",
  );
  expect(text).not.toContain("touch");
  expect(text).toMatch(
    /^printf '%s\\n' "\$\{RIG_REF_[0-9a-f]{12}\}" "\$\{RIG_REF_[0-9a-f]{12}\}\/x" 'at '"\$\{RIG_REF_[0-9a-f]{12}\}"''$/,
  );
  expect(Object.values(values).sort()).toEqual([HOSTILE, WORKSPACE].sort());
});

test.each([
  ["bare", "printf '%s\\n' ${environment.VALUE} ${rig.workspace}"],
  [
    "double quotes",
    'printf \'%s\\n\' "${environment.VALUE}" "${rig.workspace}"',
  ],
  ["single quotes", "printf '%s\\n' '${environment.VALUE}' '${rig.workspace}'"],
  [
    "a command substitution inside double quotes",
    "printf '%s\\n' \"$(printf '%s\\n' '${environment.VALUE}' ${rig.workspace})\"",
  ],
  ["a here-string", 'cat <<< ${environment.VALUE}; cat <<<"${rig.workspace}"'],
  [
    "a line continued after a blank",
    "printf '%s\\n' ${environment.VALUE} \\\n  ${rig.workspace}",
  ],
  [
    "the line after a comment holding quotes",
    "# it's \"quoted\" `here` <<EOF\nprintf '%s\\n' ${environment.VALUE} ${rig.workspace}",
  ],
  [
    "a [ ... ] test and a simple ${...} expansion",
    '[ -n "$${HOME:-none}" ] && [ ${rig.workspace} != x ] && printf \'%s\\n\' ${environment.VALUE} "$${UNSET:-${rig.workspace}}"',
  ],
  [
    "a case statement",
    "case a in a) printf '%s\\n' ${environment.VALUE} ${rig.workspace};; esac",
  ],
])("a reference in %s reaches /bin/sh as literal data", async (_, command) => {
  const ran = await run(command);
  expect(ran.files).toEqual([]);
  expect(ran.stdout.trimEnd().split("\n").slice(-2)).toEqual([
    HOSTILE,
    WORKSPACE,
  ]);
});

test("a value is one word: no brace or tilde expansion, and an argument that reads case is only a word", async () => {
  expect(
    (
      await run(
        "printf '%s\\n' {${environment.BRACE}} {${environment.RANGE}} ~${environment.USER_NAME}",
      )
    ).stdout,
  ).toBe("{a,b}\n{1..3}\n~root\n");
  expect(
    (await run('printf "%s" "$(printf "%s" case ${rig.workspace})"')).stdout,
  ).toBe(`case${WORKSPACE}`);
});

/** Text where Rig's reading of the shell may differ from /bin/sh's: a comment or a default holding `)`, a heredoc built
 * across a line continuation, backquotes, text continued inside a word or quotes, `case` inside `$(...)`. Whatever word the
 * shell makes of the variable there, it never runs the value. */
test.each([
  [
    "a comment that ends a command substitution",
    "printf '%s\\n' \"$( # )\nprintf '%s' ${environment.VALUE}\n)\"",
  ],
  [
    "a default that holds )",
    "printf '%s' \"$(printf '%s' $${UNSET:-)} ${environment.VALUE})\"",
  ],
  [
    "a heredoc formed across a line continuation",
    "cat <\\\n<EOF\n${environment.VALUE}\n${rig.workspace}\nEOF",
  ],
  ["backquotes", 'echo `echo ${environment.VALUE}` "`echo ${rig.workspace}`"'],
  [
    "a word continued onto the next line",
    "printf '%s\\n' x\\\n#${environment.VALUE}",
  ],
  [
    "double quotes continued onto the next line",
    'echo "a\\\n${environment.VALUE}"',
  ],
  [
    "a case statement inside a command substitution",
    'x="$(case a in a) echo \'${environment.VALUE}\' ${rig.workspace};; esac)"; echo "$x"',
  ],
  ["a comment", "echo ok # ${environment.VALUE}"],
  [
    "a default and a pattern expansion",
    'echo "$${HOME:-${environment.VALUE}}" "$${HOME#/}" ${rig.workspace}',
  ],
])("a reference in %s never runs its value", async (_, command) => {
  expect((await run(command)).files).toEqual([]);
});

/** Places where bash evaluates a variable's value as arithmetic or as a variable name, so even the variable runs the
 * subscript in it: each is refused, and its variable form is shown to run. */
test.each([
  ["$((...))", "echo $(( ${environment.INDEX} ))", "echo $(( $R ))"],
  ["((...))", "(( ${environment.INDEX} ))", '(( "$R" ))'],
  [
    "arithmetic formed across a line continuation",
    "echo $\\\n(( ${environment.INDEX} ))",
    "echo $\\\n(( $R ))",
  ],
  ["$[...]", "echo $[ ${environment.INDEX} ]", "echo $[ $R ]"],
  [
    "for ((...))",
    "for (( i = ${environment.INDEX}; i < 0; i++ )); do :; done",
    'for (( i = "$R"; i < 0; i++ )); do :; done',
  ],
  ["an array subscript", "a[${environment.INDEX}]=1", 'a["$R"]=1'],
  [
    "an array subscript with blanks",
    "a[ ${environment.INDEX} ]=1",
    'a[ "$R" ]=1',
  ],
  [
    "a nested array subscript",
    "a[b[0]+${environment.INDEX}]=1",
    'a[b[0]+"$R"]=1',
  ],
  [
    "a substring offset",
    'x=hello; echo "$${x: ${environment.INDEX}}"',
    'x=hello; echo "${x: $R}"',
  ],
  [
    "a variable name compared in [[ ... ]]",
    "[[ ${environment.NAME} -eq 0 ]]",
    '[[ "$INDEX_NAME" -eq 0 ]]',
  ],
  [
    "an indirect expansion",
    'name=${environment.INDEX}; echo "$${!name}"',
    'name="$R"; echo "${!name}"',
  ],
  ["let", "let n=${environment.INDEX}", 'let n="$R"'],
  ["declare -i", "declare -i n=${environment.INDEX}", 'declare -i n="$R"'],
  [
    "local -i",
    "f() { local -i n=${environment.INDEX}; }; f",
    'f() { local -i n="$R"; }; f',
  ],
  ["read", "echo x | read ${environment.INDEX}", 'echo x | read "$R"'],
])(
  "a reference in a command with %s is refused, since bash runs its value there",
  async (_, command, variableForm) => {
    expect(() => resolve(command)).toThrow(
      expect.objectContaining({
        code: "unsafe_reference",
        context: {
          path: "build",
          place: expect.stringMatching(/^in a command with /),
        },
      }),
    );
    expect(
      (await sh(variableForm, { R: INDEX, INDEX_NAME: "INDEX" })).files.length,
    ).toBeGreaterThan(0);
  },
);

test.each([
  ["a heredoc body", "cat <<EOF\n${environment.VALUE}\nEOF"],
  ["a quoted heredoc body", "cat <<'EOF'\nkeep ${rig.workspace}\nEOF"],
  ["the line after a heredoc", "cat <<EOF\nbody\nEOF\necho ${rig.workspace}"],
  ["$'...' quoting", "echo $'it\\'s ${environment.VALUE}'"],
  ["the position after a backslash", "echo \\${environment.VALUE}"],
  [
    "the position after a backslash in double quotes",
    'echo "\\${rig.workspace}"',
  ],
])("a reference in %s is refused, naming the field", (_, command) => {
  expect(() => resolve(command)).toThrow(
    expect.objectContaining({
      _tag: "ConfigError",
      code: "unsafe_reference",
      context: { path: "build", place: expect.any(String) },
      message: expect.stringContaining("A reference in build sits "),
      hint: expect.any(String),
    }),
  );
});

test("a build that writes a heredoc from references is refused when the config is parsed; the environment way it names works", async () => {
  expect(() =>
    parseProjectConfig({
      name: "heredoc",
      environment: { VALUE: "$(printf expanded)" },
      build:
        "cat > result.txt <<EOF\n${environment.VALUE}\n${rig.workspace}\nEOF\n",
      services: { web: { command: "serve" } },
    }),
  ).toThrow(
    expect.objectContaining({
      hint: 'Fix build: A reference sits in or after a heredoc (<<). Declare it in environment, such as NAME: ${...}, and write $NAME in the heredoc and "$NAME" after it.',
    }),
  );
  // The value reaches the heredoc as a variable, which the shell expands as data.
  expect((await sh("cat <<EOF\n$VALUE\nEOF")).stdout).toBe(`${HOSTILE}\n`);
});

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectConfig } from "../src/config";
import { referenceResolver } from "../src/config/references";

/** Text that runs a command, expands a variable or closes a quote if the shell ever reads it as code. Each command it could
 * run leaves a file behind in the directory the command runs in. */
const HOSTILE = "$(touch ran-dollar) `touch ran-backquote` $HOME ' \" \\ ;x";
/** An array subscript, whose command runs when bash evaluates the text as arithmetic. */
const INDEX = "b[$(touch ran-index)]";
const WORKSPACE = "/repos/ws$(touch ran-workspace)";
const environment = { VALUE: HOSTILE, INDEX, NAME: "INDEX", PORT: "4000" };
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const shell = (command: string) =>
  referenceResolver(
    { environment, services: { web: { command: "serve" } } },
    {
      target: "working",
      workspace: WORKSPACE,
      host: "",
      url: "",
      data: () => "/data",
      port: () => 4000,
    },
  ).shell(command, "build").value;
/** What /bin/sh prints for `command` in an empty directory, with the variables a Service with `environment` gets, and the
 * files it left there. */
async function run(command: string) {
  const directory = await mkdtemp(join(tmpdir(), "rig-shell-ref-"));
  roots.push(directory);
  const result = Bun.spawnSync(["/bin/sh", "-c", command], {
    cwd: directory,
    env: { PATH: process.env.PATH!, HOME: "/home/expanded", ...environment },
  });
  return {
    stdout: result.stdout.toString(),
    files: await readdir(directory),
  };
}

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
    "# it's \"quoted\" `here` <<EOF $((\nprintf '%s\\n' ${environment.VALUE} ${rig.workspace}",
  ],
  [
    "a [ ... ] test and a simple ${...} expansion",
    "[ -n \"$${HOME:-none}\" ] && [ ${rig.workspace} != x ] && printf '%s\\n' ${environment.VALUE} ${rig.workspace}",
  ],
  [
    "an array element and a for list",
    "a=(${environment.VALUE}); printf '%s\\n' \"$${a}\"; for w in ${rig.workspace}; do printf '%s\\n' \"$w\"; done",
  ],
  [
    "if, a subshell and a word that only reads case",
    "if (true) then printf '%s\\n' \"$(printf '%s' ${environment.VALUE})\"; fi; printf '%s\\n' \"$(printf case)${rig.workspace}\" | sed 's/^case//'",
  ],
])("a reference in %s reaches /bin/sh as literal data", async (_, command) => {
  const ran = await run(shell(command));
  expect(ran.files).toEqual([]);
  expect(ran.stdout.trimEnd().split("\n").slice(-2)).toEqual([
    HOSTILE,
    WORKSPACE,
  ]);
});

test("an ordinary argument that reads case is no case statement", async () => {
  const command = shell('printf "%s" "$(printf "%s" case ${rig.workspace})"');
  expect((await run(command)).stdout).toBe(`case${WORKSPACE}`);
});

/** Places where a quoted value still runs as code under /bin/sh, as the earlier quoting inserted it there; Rig refuses each. */
const RUNS_QUOTED: [string, string, string][] = [
  [
    "a heredoc formed across a line continuation",
    "cat <\\\n<EOF\n${environment.VALUE}\nEOF",
    "cat <\\\n<EOF\n'$(touch ran-dollar)'\nEOF",
  ],
  [
    "arithmetic formed across a line continuation",
    "echo $\\\n(( ${environment.INDEX} ))",
    `echo $\\\n(( '${INDEX}' ))`,
  ],
  ["an array subscript", "a[${environment.INDEX}]=1", `a['${INDEX}']=1`],
  [
    "a substring offset",
    'x=hello; echo "$${x: ${environment.INDEX}}"',
    `x=hello; echo "\${x: b[\\$(touch ran-index)]}"`,
  ],
  [
    "a variable name compared in [[ ... ]]",
    "[[ ${environment.NAME} -eq 0 ]]",
    "[[ INDEX -eq 0 ]]",
  ],
  [
    "$[...] arithmetic",
    "echo $[ ${environment.INDEX} ]",
    `echo $[ '${INDEX}' ]`,
  ],
  [
    "a for (( ... )) loop",
    "for (( i = ${environment.INDEX}; i < 0; i++ )); do :; done",
    `for (( i = '${INDEX}'; i < 0; i++ )); do :; done`,
  ],
  [
    "a command substitution inside a subscript",
    "a[$(printf '%s' ${environment.INDEX})]=1",
    `a[$(printf '%s' '${INDEX}')]=1`,
  ],
  [
    "an unquoted heredoc",
    "cat <<EOF\n${environment.VALUE}\nEOF",
    "cat <<EOF\n'$(touch ran-dollar)'\nEOF",
  ],
];
test.each(RUNS_QUOTED)(
  "a reference in %s is refused, since a quoted value runs there",
  async (_, command, quoted) => {
    expect(() => shell(command)).toThrow(
      expect.objectContaining({ code: "unsafe_reference" }),
    );
    expect((await run(quoted)).files.length).toBeGreaterThan(0);
  },
);

test.each([
  ["a quoted heredoc body", "cat <<'EOF'\nkeep ${rig.workspace}\nEOF"],
  ["the line after a heredoc", "cat <<EOF\nbody\nEOF\necho ${rig.workspace}"],
  [
    "a heredoc in a command substitution",
    'x="$(cat <<EOF\n${rig.workspace}\nEOF\n)"',
  ],
  ["$'...' quoting", "echo $'it\\'s ${environment.VALUE}'"],
  ["a comment", "echo ok # ${environment.VALUE}"],
  [
    "a comment after a line continued after a blank",
    "echo ok \\\n# ${environment.VALUE}",
  ],
  [
    "a word continued onto the next line",
    "printf '%s\\n' x\\\n#${environment.VALUE}",
  ],
  [
    "double quotes continued onto the next line",
    'echo "a\\\n${rig.workspace}"',
  ],
  ["the position after a backslash", "echo \\${environment.VALUE}"],
  [
    "the position after a backslash in double quotes",
    'echo "\\${rig.workspace}"',
  ],
  ["backquotes", "echo `echo ${environment.VALUE}`"],
  ["the command after backquotes", "echo `date`; echo ${environment.VALUE}"],
  ["a case statement", "case a in a) echo ${environment.VALUE};; esac"],
  [
    "a case statement inside a command substitution",
    "x=\"$(case a in a) echo '${environment.VALUE}';; esac)\"",
  ],
  ["arithmetic, even for a number", "echo $(( ${environment.PORT} + 1 ))"],
  ["an arithmetic command", "(( ${rig.workspace} ))"],
  ["the command after [[ ... ]]", "[[ -n x ]] && echo ${environment.VALUE}"],
  ["a ${...} expansion", 'echo "$${HOME:-${environment.VALUE}}"'],
  [
    "the command after a ${...} expansion with a pattern",
    'echo "$${HOME#/}" ${rig.workspace}',
  ],
  ["a pattern in a word", "ls file[${environment.VALUE}]"],
])("a reference in %s is refused, naming the field", (_, command) => {
  expect(() => shell(command)).toThrow(
    expect.objectContaining({
      _tag: "ConfigError",
      code: "unsafe_reference",
      context: { path: "build", place: expect.any(String) },
      message: expect.stringContaining("A reference in build sits "),
      hint: expect.any(String),
    }),
  );
});

test("a build that writes a heredoc from references is refused when the config is parsed, with the environment as the way to pass them", () => {
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
      hint: 'Fix build: A reference sits in or after a heredoc (<<). Declare it in environment, such as NAME: ${...}, and write "$NAME" instead.',
    }),
  );
  // The way the hint names: the value reaches the heredoc as a variable, which the shell expands as data.
  expect(
    parseProjectConfig({
      name: "heredoc",
      environment: { VALUE: "$(printf expanded)" },
      build: "cat > result.txt <<EOF\n$VALUE\nEOF\n",
      services: { web: { command: "serve" } },
    }).build,
  ).toBe("cat > result.txt <<EOF\n$VALUE\nEOF\n");
});

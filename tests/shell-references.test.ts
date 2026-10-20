import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectConfig } from "../src/config";
import { referenceResolver } from "../src/config/references";

/** Text that runs a command, expands a variable or closes a quote if the shell ever reads it as code. Each command it could
 * run leaves a file behind in the directory the command runs in. */
const HOSTILE = "$(touch ran-dollar) `touch ran-backquote` $HOME ' \" \\ ;x";
const WORKSPACE = "/repos/ws$(touch ran-workspace)";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const resolver = () =>
  referenceResolver(
    {
      environment: { VALUE: HOSTILE },
      services: { web: { command: "serve", ports: { http: 4000 } } },
    },
    {
      target: "working",
      workspace: WORKSPACE,
      host: "",
      url: "",
      data: () => "/data",
      port: () => 4000,
    },
  );
const shell = (command: string, at = "build") =>
  resolver().shell(command, at).value;
/** What /bin/sh prints for `command` in an empty directory, and the files it left there. */
async function run(command: string) {
  const directory = await mkdtemp(join(tmpdir(), "rig-shell-ref-"));
  roots.push(directory);
  const result = Bun.spawnSync(["/bin/sh", "-c", command], {
    cwd: directory,
    env: { PATH: process.env.PATH!, HOME: "/home/expanded" },
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    files: await readdir(directory),
  };
}

test.each([
  ["bare", "printf '%s\\n' ${environment.VALUE} ${rig.workspace}"],
  ["double quotes", 'printf \'%s\\n\' "${environment.VALUE}" "${rig.workspace}"'],
  ["single quotes", "printf '%s\\n' '${environment.VALUE}' '${rig.workspace}'"],
  [
    "a command substitution inside double quotes",
    "printf '%s\\n' \"$(printf '%s\\n' '${environment.VALUE}' ${rig.workspace})\"",
  ],
  [
    "a here-string",
    "cat <<< ${environment.VALUE}; cat <<<\"${rig.workspace}\"",
  ],
  [
    "the line after an unquoted heredoc",
    "cat <<EOF\n$HOME\nEOF\nprintf '%s\\n' ${environment.VALUE} ${rig.workspace}",
  ],
  [
    "the line after a quoted, tab-stripped heredoc in a command substitution",
    "x=$(cat <<-'EOF'\n\tEOF in the body ends nothing\n\tEOF\n); printf '%s\\n' ${environment.VALUE} \"${rig.workspace}\"",
  ],
  [
    "the line after two heredocs on one line",
    "cat <<A; cat <<\"B\"\nA\nB\nprintf '%s\\n' ${environment.VALUE} ${rig.workspace}",
  ],
  [
    "a line continued after a word",
    "printf '%s\\n' ${environment.VALUE} \\\n  ${rig.workspace}",
  ],
  [
    "the line after a comment holding quotes",
    "# it's \"quoted\" `here`\nprintf '%s\\n' ${environment.VALUE} ${rig.workspace}",
  ],
])(
  "a reference in %s reaches /bin/sh as literal data",
  async (_, command) => {
    const ran = await run(shell(command));
    expect(ran.files).toEqual([]);
    expect(ran.stdout.trimEnd().split("\n").slice(-2)).toEqual([
      HOSTILE,
      WORKSPACE,
    ]);
  },
);

test("a port in arithmetic or [[ ... ]] stays a number, and an escaped character before a reference is still the author's", async () => {
  const command = shell(
    "echo $(( ${port} + 1 )); (( ${port} > 1 )) && [[ ${port} -eq 4000 ]] && echo yes; echo \\$x${port}",
    "services.web.command",
  );
  expect(command).toBe(
    "echo $(( 4000 + 1 )); (( 4000 > 1 )) && [[ 4000 -eq 4000 ]] && echo yes; echo \\$x4000",
  );
  const ran = await run(command);
  expect(ran.stdout).toBe("4001\nyes\n$x4000\n");
});

test.each([
  ["an unquoted heredoc body", "cat <<EOF\n${environment.VALUE}\nEOF"],
  ["a quoted heredoc body", "cat <<'EOF'\nkeep ${rig.workspace}\nEOF"],
  ["a tab-stripped heredoc body", "cat <<-EOF\n\t${rig.workspace}\n\tEOF"],
  ["a heredoc's delimiter", "cat <<${environment.VALUE}\nbody\n"],
  ["the rest of a heredoc's line", "cat <<EOF; echo ${rig.workspace}\nEOF"],
  [
    "a second heredoc's body",
    "cat <<A <<B\nA\n${environment.VALUE}\nB",
  ],
  [
    "a heredoc body after a line that only resembles its delimiter",
    "cat <<EOF\nEOF \n\tEOF\n${environment.VALUE}\nEOF",
  ],
  [
    "a heredoc body after a backslash joined its delimiter to the line before",
    "cat <<EOF\nline\\\nEOF\n${environment.VALUE}\nEOF",
  ],
  [
    "a heredoc in a command substitution",
    'x="$(cat <<EOF\n${rig.workspace}\nEOF\n)"',
  ],
  ["$'...' quoting", "echo $'it\\'s ${environment.VALUE}'"],
  ["a comment", "echo ok # ${environment.VALUE}"],
  [
    "a comment after a word continued onto its line",
    "echo ok \\\n# ${environment.VALUE}",
  ],
  ["the position after a backslash", "echo \\${environment.VALUE}"],
  ["the position after a backslash in double quotes", 'echo "\\${rig.workspace}"'],
  ["backquotes", "echo `echo ${environment.VALUE}`"],
  [
    "a case statement inside a command substitution",
    "x=\"$(case a in a) echo '${environment.VALUE}';; esac)\"",
  ],
  ["arithmetic, for a value that is not a number", "echo $(( ${environment.VALUE} ))"],
  ["an arithmetic command", "(( ${rig.workspace} ))"],
  ["[[ ... ]], for a value that needs quoting", "[[ ${rig.workspace} -eq 1 ]]"],
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

test("a word continued onto the next line keeps a # there as part of it, so the reference after it is not in a comment", async () => {
  const command = shell("printf '%s\\n' x\\\n#${environment.VALUE}");
  const ran = await run(command);
  expect(ran.files).toEqual([]);
  expect(ran.stdout).toBe(`x#${HOSTILE}\n`);
});

test("a build that writes a heredoc from references is refused when the config is parsed, with the environment as the way to pass them", () => {
  expect(() =>
    parseProjectConfig({
      name: "heredoc",
      environment: { VALUE: "$(printf expanded)" },
      build: "cat > result.txt <<EOF\n${environment.VALUE}\n${rig.workspace}\nEOF\n",
      services: { web: { command: "serve" } },
    }),
  ).toThrow(
    expect.objectContaining({
      hint: 'Fix build: A reference sits in a heredoc. Declare it in environment, such as NAME: ${...}, and write "$NAME" instead.',
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

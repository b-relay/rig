import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Command } from "commander";
import { createRigCommand } from "../src/cli/commands";
import { isHelp } from "../src/cli/failure";
import { RigError } from "../src/domain/errors";
import {
  rigCommand,
  type CommandSelection,
  type RigCommandPath,
} from "../src/domain/rig-command";
import { generatedPreviewName } from "../src/domain/target-selector";
import { pendingRenameAdvice } from "../src/runtime/rename";
import { previewReplacement } from "../src/runtime/doctor";
import { hostnameRelease } from "../src/runtime/application";
import { shellArgs } from "./support/shell-args";
import type { RuntimeCommand } from "../src/daemon/protocol";

/** Every command a hint, a help text or the documentation tells the user to run must be one the CLI's grammar accepts.
 * Parsing runs the real grammar with every effect stubbed: whatever reaches rigd, the terminal or the DNS read counts as
 * accepted. */
const ROOT = join(import.meta.dir, "..");
const ACCEPTED = new Error("accepted by the grammar");
function grammar(): Command {
  const accepted = async () => {
    throw ACCEPTED;
  };
  return createRigCommand(
    "/workspace",
    { write() {}, error() {} },
    accepted,
    () => new Date("2026-10-20T12:00:00Z"),
    { proxyToken: accepted, proxyVerify: accepted },
    { read: accepted },
  );
}
/** Undefined when `args` (the words after `rig`) parse, else why not. */
async function refusal(args: readonly string[]): Promise<string | undefined> {
  try {
    await grammar().parseAsync([...args], { from: "user" });
    return undefined;
  } catch (error) {
    if (error === ACCEPTED || isHelp(error)) return undefined;
    if (error instanceof RigError && error.code !== "USAGE") return undefined;
    return error instanceof Error ? error.message : String(error);
  }
}
/** A documented placeholder, filled with a value of its kind. */
const PLACEHOLDERS: Record<string, string> = {
  branch: "feature/login",
  name: "demo",
  "new name": "renamed",
  "other name": "other",
  new: "renamed",
  job: "nightly-db",
  id: "20261011T030000Z-17",
  backup: "20261011T030000Z-17",
  "id|latest": "latest",
  target: "stable",
  path: "/tmp/moved",
  "new path": "/tmp/moved",
  content: "192.0.2.1",
  test: "true",
  seconds: "60",
  "seconds|auto": "auto",
  zone: "example.com",
  time: "1h",
  count: "5",
  operation: "3f2a9c1e",
  "request-file": "/tmp/request.json",
  type: "A",
  number: "10",
  text: "note",
  command: "true",
  domain: "app.example.com",
  port: "8443",
  service: "web",
  version: "v1.2.3",
  production: "main",
  "current name": "demo",
};
function filled(command: string): string | undefined {
  let unknown = false;
  // rig help takes a command path.
  const text = command
    .replace(/^rig help <command>/, "rig help deploy")
    .replace(/<([^<>]+)>/g, (_, name: string) => {
      const value = PLACEHOLDERS[name];
      if (value === undefined) unknown = true;
      return value ?? "";
    });
  return unknown ? undefined : text;
}

function files(directory: string, pattern: RegExp): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory())
      return ["node_modules", ".next"].includes(name)
        ? []
        : files(path, pattern);
    return pattern.test(name) && !name.includes(".test.") ? [path] : [];
  });
}
const SOURCES = [
  ...files(join(ROOT, "src"), /\.tsx?$/),
  ...files(join(ROOT, "web"), /\.tsx?$/),
];
/** The user documentation, whose code shows commands to run; decision records keep the words of their day. */
const GUIDES = [
  "README.md",
  "docs/commands.md",
  "docs/rig-guide.md",
  "docs/website.md",
].map((path) => join(ROOT, path));
/** Documents that name commands in prose, such as the design and the glossary. */
const DOCUMENTS = [
  ...GUIDES,
  ...["DESIGN.md", "CONTEXT.md"].map((path) => join(ROOT, path)),
];
/** Every command's --help, as `rig help <path>` prints it. */
function helpTexts(): { path: string; text: string }[] {
  const texts: { path: string; text: string }[] = [];
  const visit = (command: Command, path: string[]) => {
    texts.push({
      path: ["rig", ...path].join(" "),
      text: command.helpInformation(),
    });
    for (const child of command.commands) visit(child, [...path, child.name()]);
  };
  visit(grammar(), []);
  return texts;
}

/** Commands the documents name as ones Rig does not have, and the guide's example of an unknown one. */
const ABSENT = new Set(["bump", "fetch", "sync", "nonsense"]);
/** Words that follow "rig" or a command group in prose ("rig never reruns a build", "rig proxy shows them") rather
 * than naming a command. */
const PROSE = new Set(
  "alive and begin checks command commands could discovers does end entrypoint exits for from in is itself never only or prints reads reports resolves runs sends shows stored takes to waits with writes".split(
    " ",
  ),
);
/** The lower-case words after every "rig " in `text`, up to three. */
function mentions(text: string): string[][] {
  return [...text.matchAll(/(?<![\w/.-])rig(?=((?: [a-z][a-z-]*){1,3}))/g)].map(
    (match) => match[1]!.trim().split(" "),
  );
}

test("every rig command any hint, help text or document mentions exists, with its subcommand", () => {
  const root = grammar();
  const find = (command: Command, name: string) =>
    command.commands.find(
      (child) => child.name() === name || child.aliases().includes(name),
    );
  const named = (word: string | undefined) =>
    word !== undefined && !PROSE.has(word) && !ABSENT.has(word);
  const wrong: string[] = [];
  const check = (where: string, text: string) => {
    for (const words of mentions(text)) {
      const [first, ...rest] = words;
      if (!named(first)) continue;
      const command = find(root, first!);
      if (!command) {
        wrong.push(`${where}: rig ${first}`);
        continue;
      }
      // A group's next word is its subcommand. rig help walks a path of commands, so each word must be one there.
      let level = first === "help" ? root : command;
      for (const word of first === "help" ? rest : rest.slice(0, 1)) {
        if (!named(word) || (first !== "help" && !level.commands.length)) break;
        const next = find(level, word);
        if (!next) {
          wrong.push(`${where}: rig ${words.join(" ")}`);
          break;
        }
        level = next;
      }
    }
  };
  for (const path of [...SOURCES, ...DOCUMENTS])
    check(relative(ROOT, path), readFileSync(path, "utf8"));
  for (const { path, text } of helpTexts()) check(`${path} --help`, text);
  expect(wrong).toEqual([]);
});

/** The commands a document's code shows: a code span, or a line of a code block (continued lines joined), that starts
 * with `rig `. */
function documentedCommands(text: string): string[] {
  const blocks = [...text.matchAll(/^```[a-z]*\n([\s\S]*?)^```/gm)].flatMap(
    (match) => match[1]!.replace(/\\\n\s*/g, " ").split("\n"),
  );
  return [
    ...[...text.matchAll(/`(rig [^`\n]+)`/g)].map((match) => match[1]!),
    ...blocks.flatMap((line) => {
      const command = /^\s*(?:\$ )?(rig [^#]*?)\s*(?:#.*)?$/.exec(line);
      return command ? [command[1]!] : [];
    }),
  ];
}
/** The examples a help text shows, one per line. */
function helpExamples(text: string): string[] {
  return [...text.matchAll(/^ {2}(rig .*?)\s*$/gm)].map((match) => match[1]!);
}
/** What the documents show failing on purpose, to say how a mistake is refused. */
const SHOWN_REFUSED = new Set([
  "rig help nonsense",
  "rig up --bogus",
  'rig repoint ""',
  'rig deploy preview ""',
  "rig config set",
]);

test("every complete rig command the documents and help texts show parses with the CLI's grammar", async () => {
  const root = grammar();
  /** A command named alone (`rig forget`), to refer to it rather than to run it. */
  const named = (words: string[]) => {
    let command: Command | undefined = root;
    for (const word of words)
      command = command?.commands.find((child) => child.name() === word);
    return command !== undefined;
  };
  const shown = [
    ...GUIDES.flatMap((path) =>
      documentedCommands(readFileSync(path, "utf8")).map((command) => ({
        where: relative(ROOT, path),
        command,
      })),
    ),
    ...helpTexts().flatMap(({ path, text }) =>
      helpExamples(text).map((command) => ({
        where: `${path} --help`,
        command,
      })),
    ),
  ];
  const refused: string[] = [];
  let checked = 0;
  for (const { where, command } of shown) {
    // An elided command, a synopsis with [optional] parts, or a choice of values (stdout|stderr) is not one to run.
    if (/…|\.\.\.|\[|(?<![ |])\|/.test(command) || SHOWN_REFUSED.has(command))
      continue;
    const line = filled(command.replace(/[.,;:]$/, ""));
    if (line === undefined) {
      refused.push(`${where}: ${command} (an unknown placeholder)`);
      continue;
    }
    let args: string[];
    try {
      args = shellArgs(line);
    } catch (error) {
      refused.push(`${where}: ${command} (${String(error)})`);
      continue;
    }
    if (named(args)) continue;
    const why = await refusal(args);
    checked++;
    if (why) refused.push(`${where}: ${command} (${why})`);
  }
  expect(refused).toEqual([]);
  expect(checked).toBeGreaterThan(50);
}, 60_000);

test("no document says an action, such as a deploy or a lifecycle command, prints JSON", async () => {
  // Only reads take --json; a shown command with it on an action fails to parse above, and this holds the prose to it too.
  const actions = grammar()
    .commands.filter(
      (command) =>
        !command.options.some((option) => option.long === "--json") &&
        !command.commands.length,
    )
    .map((command) => command.name());
  expect(actions).toEqual(expect.arrayContaining(["deploy", "up", "restart"]));
  const action = new RegExp(
    `\\b(deploy|lifecycle)\\b|\`rig (${actions.join("|")})\\b`,
  );
  const claims = DOCUMENTS.flatMap((path) =>
    readFileSync(path, "utf8")
      .replace(/^```[a-z]*\n[\s\S]*?^```/gm, "")
      .replace(/\s+/g, " ")
      .split(/(?<=[.;:])\s+/)
      .filter((sentence) => /JSON|--json/.test(sentence))
      .filter((sentence) => action.test(sentence))
      .map((sentence) => `${relative(ROOT, path)}: ${sentence}`),
  );
  expect(claims).toEqual([]);
});

test("every hint rigd and rig render with rigCommand, pasted into a shell, selects the Target, job and Project it names", async () => {
  // Branches and Project names the shell would read: an apostrophe, a space, $ expansions, a leading =.
  const branches = [
    "feature/login",
    "feat/(draft) it's",
    "feat/$((1+1))",
    "fix/$HOME",
    "=ls",
    // Target words, which a jobless rig backup list after preview reads as a job and its Target.
    "stable",
    "working",
    "preview",
  ];
  const targets: CommandSelection["target"][] = [
    { kind: "working", name: "working" },
    { kind: "stable", name: "stable" },
    ...branches.map((branch) => ({
      kind: "preview" as const,
      name: generatedPreviewName(branch),
      branch,
    })),
    { kind: "preview", name: "demo", branch: "feature/login" },
    { kind: "preview", name: "demo" },
  ];
  const paths: RigCommandPath[] = [
    "up",
    "down",
    "restart",
    "deploy",
    "run",
    "logs",
    "backup list",
    "backup restore",
  ];
  // Job names that are also Target words, which the grammar must not take for a Target.
  const jobs = ["nightly-db", "preview", "stable", "working"];
  const takesJob = (path: RigCommandPath) =>
    path === "run" || path.startsWith("backup");
  const cases = paths.flatMap((path) =>
    targets.flatMap((target) =>
      // rig backup list also lists a whole Target, with no job.
      (path === "backup list"
        ? [undefined, ...jobs]
        : takesJob(path)
          ? jobs
          : [undefined]
      ).flatMap((job) =>
        ["my shop", "it's $x"].map((project) => ({
          path,
          target: target!,
          job,
          project,
        })),
      ),
    ),
  );
  for (const { path, target, job, project } of cases) {
    if (path === "deploy" && target.kind === "working") continue;
    const line = rigCommand(path, {
      target: { ...target, plan: { project } },
      ...(job !== undefined ? { job } : {}),
      ...(path === "backup restore" ? { backup: "latest" } : {}),
      ...(path === "logs" ? { service: "web" } : {}),
    });
    const requests: RuntimeCommand[] = [];
    await createRigCommand(
      "/workspace",
      { write() {}, error() {} },
      async (request) => {
        requests.push(request);
      },
    )
      .parseAsync(shellArgs(line), { from: "user" })
      .catch((error: unknown) => {
        throw new Error(`${line}: ${String(error)}`);
      });
    const [sent] = requests;
    // The Preview it selects is the one whose name its Branch or --deployment gives.
    const selected =
      sent?.target === "preview"
        ? (sent.deployment ??
          (sent.branch === undefined
            ? undefined
            : generatedPreviewName(sent.branch)))
        : sent?.target;
    expect({
      line,
      requests: requests.length,
      selected,
      job: sent?.job,
    }).toEqual({
      line,
      requests: 1,
      selected: target.name,
      job,
    });
    expect(sent).toMatchObject({
      project,
      target: target.kind,
      ...(path === "backup restore" ? { backup: "latest" } : {}),
    });
  }
}, 60_000);

test("a line the shell refuses, such as one with an unmatched quote, is refused at once", () => {
  expect(() => shellArgs("rig up preview 'feature")).toThrow(
    "the shell refused",
  );
  expect(shellArgs("rig up preview 'it'\\''s' --project \"a b\"")).toEqual([
    "up",
    "preview",
    "it's",
    "--project",
    "a b",
  ]);
});

test("the advice for an unfinished rename names rename commands the grammar accepts", async () => {
  const advice = [
    pendingRenameAdvice({ name: "before", repoPath: "/r" }, { to: "after" }),
    pendingRenameAdvice({ name: "before", repoPath: "/r" }, { to: "before" }),
    pendingRenameAdvice(
      { name: "a".repeat(129), repoPath: "/r" },
      { to: "short" },
    ),
  ].join(" ");
  const commands = [...advice.matchAll(/rig rename .+?(?= to | in )/g)].map(
    (match) => match[0],
  );
  expect(commands).toEqual([
    "rig rename after --project before",
    "rig rename before --project before",
    "rig rename before --project before",
    "rig rename short",
  ]);
  for (const command of commands)
    expect(await refusal(shellArgs(command))).toBeUndefined();
});

test("a ROUTE_CONFLICT hint frees the hostname with commands that act on its holder, in the holder's Project", async () => {
  const project = "it's $x";
  const holders = [
    { kind: "working" as const, name: "working" },
    { kind: "stable" as const, name: "stable" },
    {
      kind: "preview" as const,
      name: generatedPreviewName("feat/(draft) it's"),
      branch: "feat/(draft) it's",
    },
    { kind: "preview" as const, name: "demo", branch: "feature/login" },
  ];
  const sent: RuntimeCommand[][] = [];
  for (const holder of holders) {
    const hint = hostnameRelease({ ...holder, plan: { project } });
    const requests: RuntimeCommand[] = [];
    for (const [, line] of hint.matchAll(/run (rig .+?)(?=, |$)/g))
      await createRigCommand(
        "/workspace",
        { write() {}, error() {} },
        async (request) => {
          requests.push(request);
        },
      )
        .parseAsync(shellArgs(line!), { from: "user" })
        .catch((error: unknown) => {
          throw new Error(`${line}: ${String(error)}`);
        });
    sent.push(requests);
  }
  const forget = { action: "forget", project };
  expect(sent).toMatchObject([
    [{ action: "restart", target: "working", project }, forget],
    [{ action: "deploy", target: "stable", project }, forget],
    [
      {
        action: "destroy",
        target: "preview",
        branch: "feat/(draft) it's",
        project,
      },
      forget,
    ],
    [
      { action: "destroy", target: "preview", deployment: "demo", project },
      forget,
    ],
  ]);
});

test("doctor's replacement of a legacy Preview deploys and destroys in the Preview's own Project", async () => {
  const target = {
    kind: "preview" as const,
    name: "all",
    branch: "feat/(draft) it's",
    plan: { project: "my shop" },
  } as Parameters<typeof previewReplacement>[0];
  const requests: RuntimeCommand[] = [];
  for (const line of previewReplacement(target))
    await createRigCommand(
      "/workspace",
      { write() {}, error() {} },
      async (request) => {
        requests.push(request);
      },
    ).parseAsync(shellArgs(line.replace("<new name>", "renamed")), {
      from: "user",
    });
  expect(requests).toMatchObject([
    {
      action: "deploy",
      target: "preview",
      branch: "feat/(draft) it's",
      deployment: "renamed",
      project: "my shop",
    },
    { target: "preview", deployment: "all", project: "my shop" },
  ]);
});

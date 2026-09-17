import { test, expect } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { createTerminalInteraction } from "../src/adapters/terminal-interaction";
import { runRigCli } from "../src/cli/rig";
import type { ProjectStatusReport } from "../src/domain/project-status";

function fixture() {
  const input = new PassThrough(),
    controller = new AbortController();
  let text = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  return {
    input,
    controller,
    output,
    text: () => text,
    interaction: createTerminalInteraction(input, output, {
      signal: controller.signal,
      interrupt: () => controller.abort(),
    }),
  };
}
/** A terminal-mode readline turns the Ctrl-C byte into its own SIGINT event instead of a process signal. */
function terminalFixture() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {
      return input;
    },
  });
  let text = "";
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        text += chunk.toString();
        done();
      },
    }),
    { isTTY: true, columns: 80 },
  );
  return { input, output, text: () => text };
}
test("terminal EOF cancels pending input instead of leaving an unresolved question", async () => {
  const f = fixture(),
    question = f.interaction.text("Name", "demo");
  f.input.end();
  const outcome = await Promise.race([
    question.then(
      () => "answered",
      (error) => error.code,
    ),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 100)),
  ]);
  f.controller.abort();
  expect(outcome).toBe("CANCELLED");
});
test("terminal displays defaults and choices without executing terminal control sequences", async () => {
  const f = fixture(),
    question = f.interaction.text(
      "Name\x1b[2J",
      "demo\x1b]52;c;YWJj\x07\nforged",
    );
  f.input.write("\n");
  await question;
  expect(f.text()).toBe("Name [demo forged]: ");
  const choices = f.interaction.select("Target\rforged", [
    { value: "live", label: "live\x1b[2J" },
  ]);
  f.input.write("1\n");
  expect(await choices).toBe("live");
  expect(f.text()).toContain("Target forged\n  1. live\nNumber: ");
  f.input.destroy();
});
test("terminal cancellation before a question creates no prompt and returns a cancellation", async () => {
  const f = fixture();
  f.controller.abort();
  await expect(f.interaction.confirm("Continue?")).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(f.text()).toBe("");
  f.input.destroy();
});

test("Ctrl-C at a prompt reports through the shared interrupt, so it is the same cancellation as Ctrl-C elsewhere", async () => {
  const f = terminalFixture();
  const controller = new AbortController();
  let interrupts = 0;
  const interaction = createTerminalInteraction(f.input, f.output, {
    signal: controller.signal,
    interrupt: () => {
      interrupts++;
      controller.abort();
    },
  });
  const question = interaction.confirm("Continue?");
  f.input.write("\x03");
  await expect(question).rejects.toMatchObject({ code: "CANCELLED" });
  expect(interrupts).toBe(1);
  expect(controller.signal.aborted).toBe(true);
  f.input.destroy();
});
test("Ctrl-C at a deploy confirmation exits 0 without an error message or a failure record", async () => {
  const f = terminalFixture();
  const controller = new AbortController();
  const events: string[] = [];
  let text = "";
  const exit = await runRigCli(["deploy", "live"], {
    root: "/isolated/.rig",
    cwd: "/workspace",
    signal: controller.signal,
    interaction: createTerminalInteraction(f.input, f.output, {
      signal: controller.signal,
      interrupt: () => controller.abort(),
    }),
    client: {
      async status(): Promise<ProjectStatusReport> {
        throw new Error("Unexpected status");
      },
      async command(request) {
        if (request.action !== "deployment-context")
          throw new Error(`Unexpected ${request.action}`);
        setTimeout(() => f.input.write("\x03"), 10);
        return {
          project: "demo",
          repoPath: "/repo",
          productionBranch: "main",
          currentBranch: "feature/wip",
          targets: { working: "local", stable: "live" },
          selected: "stable",
        };
      },
    },
    output: {
      write(value) {
        text += value;
      },
      error(value) {
        text += value;
      },
    },
    diagnostics: {
      async record(entry) {
        events.push(entry.event);
        return {};
      },
    },
    wait: async () => {},
    newOperationId: () => "unused",
  });
  expect(exit).toBe(0);
  expect(f.text()).toContain("Deploy Production branch 'main'");
  expect(text).not.toContain("cancelled");
  expect(events).toEqual([]);
  f.input.destroy();
});

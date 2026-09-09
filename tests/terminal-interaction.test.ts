import { test, expect } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { createTerminalInteraction } from "../src/adapters/terminal-interaction";

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
    interaction: createTerminalInteraction(input, output, controller.signal),
  };
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
  expect(f.text()).toBe("Name [demoforged]: ");
  const choices = f.interaction.select("Target\rforged", [
    { value: "live", label: "live\x1b[2J" },
  ]);
  f.input.write("1\n");
  expect(await choices).toBe("live");
  expect(f.text()).toContain("Targetforged\n  1. live\nNumber: ");
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

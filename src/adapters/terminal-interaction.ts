import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { CliInteraction } from "../cli/interaction";
import { terminalText } from "../cli/terminal-text";
import { RigError } from "../domain/errors";

const cancelled = () =>
  new RigError(
    "CANCELLED",
    "The operation was cancelled.",
    "No runtime change was requested.",
  );
/** Owns terminal lifetime. SIGINT, EOF and AbortSignal all settle the pending question. */
export function createTerminalInteraction(
  input: Readable,
  output: Writable,
  signal: AbortSignal,
): CliInteraction {
  const question = async (prompt: string): Promise<string> => {
    if (signal.aborted || input.readableEnded || input.destroyed)
      throw cancelled();
    const terminal = createInterface({ input, output });
    let cancel: () => void = () => {};
    try {
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        cancel = () => {
          if (!settled) {
            settled = true;
            reject(cancelled());
          }
        };
        terminal.once("SIGINT", cancel);
        terminal.once("close", cancel);
        signal.addEventListener("abort", cancel, { once: true });
        terminal.question(prompt).then(
          (answer) => {
            if (!settled) {
              settled = true;
              resolve(answer);
            }
          },
          (error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          },
        );
      });
    } finally {
      signal.removeEventListener("abort", cancel);
      terminal.removeListener("SIGINT", cancel);
      terminal.removeListener("close", cancel);
      terminal.close();
    }
  };
  return {
    async text(message, defaultValue) {
      const answer = await question(
        `${terminalText(message)} [${terminalText(defaultValue)}]: `,
      );
      return answer.trim() || defaultValue;
    },
    async confirm(message) {
      return /^(y|yes)$/i.test(
        (await question(`${terminalText(message)} [y/N]: `)).trim(),
      );
    },
    async select(message, choices) {
      if (signal.aborted) throw cancelled();
      output.write(
        `${terminalText(message)}\n${choices.map((choice, index) => `  ${index + 1}. ${terminalText(choice.label)}`).join("\n")}\n`,
      );
      const selected = Number((await question("Number: ")).trim());
      return Number.isInteger(selected)
        ? (choices[selected - 1]?.value ?? "")
        : "";
    },
  };
}

import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { CliInteraction } from "../cli/interaction";
import { terminalText } from "../cli/terminal-text";
import { cancelled } from "../domain/errors";

/** Owns terminal lifetime. A terminal-mode readline turns Ctrl-C into its own
 * event instead of a process signal, so a prompt-time Ctrl-C (and EOF) is
 * reported through `interrupt`, making it the same cancellation as Ctrl-C
 * anywhere else; the signal settles a pending question too. */
export function createTerminalInteraction(
  input: Readable,
  output: Writable,
  interrupts: { signal: AbortSignal; interrupt: () => void },
): CliInteraction {
  const { signal, interrupt } = interrupts;
  const question = async (prompt: string): Promise<string> => {
    if (signal.aborted || input.readableEnded || input.destroyed)
      throw cancelled();
    const terminal = createInterface({ input, output });
    let cancel: () => void = () => {};
    let interrupted: () => void = () => {};
    try {
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        cancel = () => {
          if (!settled) {
            settled = true;
            reject(cancelled());
          }
        };
        interrupted = () => {
          interrupt();
          cancel();
        };
        terminal.once("SIGINT", interrupted);
        terminal.once("close", interrupted);
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
      terminal.removeListener("SIGINT", interrupted);
      terminal.removeListener("close", interrupted);
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

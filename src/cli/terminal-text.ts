import { stripVTControlCharacters } from "node:util";
/** The one policy for single-line terminal text, prompts and output alike: a
 * value from a repository (a Project, Target, Branch or Component name, a log
 * line) cannot carry a terminal command, forge another line, or reorder what
 * is shown. Escape sequences (7- and 8-bit), zero-width characters and bidi
 * controls are removed; other C0, DEL and C1 controls become a space so word
 * boundaries survive. */
export function terminalText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

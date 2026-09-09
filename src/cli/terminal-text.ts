import { stripVTControlCharacters } from "node:util";
/** Single-line display text cannot carry terminal commands or forge additional prompt lines. */
export function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,
    "",
  );
}

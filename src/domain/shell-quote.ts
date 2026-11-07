/** `value` as POSIX shell text between single quotes: each `'` closes the quotes, is escaped, and opens them again. */
export function withinSingleQuotes(value: string): string {
  return value.replaceAll("'", "'\\''");
}
/** `value` as one single-quoted POSIX shell word, which the shell reads as exactly `value`: never split, globbed,
 * expanded, or taken for an assignment, a reserved word or an operator. */
export function shellQuote(value: string): string {
  return `'${withinSingleQuotes(value)}'`;
}

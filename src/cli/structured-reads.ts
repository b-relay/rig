import { commandPath } from "./commands";

/** The reads, by their command path; each takes --json: `proxy verify` and `backup list`, not `proxy reload` or
 * `backup restore`. */
const STRUCTURED_READS = [
  "list",
  "status",
  "doctor",
  "config",
  "activity",
  "logs",
  "monitor",
  "proxy",
  "proxy verify",
  "dns list",
  "backup list",
];
/** Whether the arguments name a read, from the grammar, even when argument validation fails before execution. The
 * command path is read from the words alone, so `rig proxy --json reload` is the reload it names. */
export function namesRead(
  command: Parameters<typeof commandPath>[0],
  args: readonly string[],
): boolean {
  const words = beforeSeparator(args).filter((arg) => !arg.startsWith("-"));
  return STRUCTURED_READS.includes(commandPath(command, words).join(" "));
}
/** Error rendering follows the same scoped flag as the read's report. */
export function requestsJson(args: readonly string[]): boolean {
  return beforeSeparator(args).includes("--json");
}
function beforeSeparator(args: readonly string[]): readonly string[] {
  const end = args.indexOf("--");
  return end < 0 ? args : args.slice(0, end);
}

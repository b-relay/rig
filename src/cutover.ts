import { runCutover } from "./conversion/index";
import {
  reportRootFailure,
  rigRoot,
  userOutput,
} from "./cli/entry-environment";
import { processExists } from "./daemon/process-identity";
/** Source-run entry (`bun run cutover`); deliberately not compiled into rig or rigd. */
export async function main(args: readonly string[]): Promise<number> {
  const output = userOutput();
  let root: string;
  try {
    root = rigRoot();
  } catch (error) {
    return reportRootFailure(error, output);
  }
  return runCutover(args, {
    root,
    output,
    pidAlive: processExists,
    now: () => new Date().toISOString(),
  });
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));

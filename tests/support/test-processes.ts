import { AsyncLocalStorage } from "node:async_hooks";

/** What one test runs: once it has ended, the processes it still waits on are killed and it may start no more. Bun fails a
 * test at its timeout but leaves its body running, so without this a timed-out body goes on into the next test. */
export interface TestScope {
  ended: boolean;
  /** The process groups of the processes it still waits on: each is started as its group's leader, so a descendant that
   * holds the output open is in the group too. */
  readonly groups: Set<number>;
}
const scopes = new AsyncLocalStorage<TestScope>();

export const testScope = (): TestScope => ({ ended: false, groups: new Set() });
/** Runs `body` as `scope`'s, so every process it starts with `runOwned`, however late, is the scope's. */
export function within<T>(
  scope: TestScope,
  body: () => Promise<T>,
): Promise<T> {
  return scopes.run(scope, body);
}
/** The scope the caller runs in, if any. */
export const currentScope = (): TestScope | undefined => scopes.getStore();

/** Runs `args` to its end in a process group of its own, answering its exit status and output. Fails at once when the
 * caller's test has ended. */
export async function runOwned(
  args: readonly string[],
  options: { env: Record<string, string>; cwd?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const scope = scopes.getStore();
  if (scope?.ended)
    throw new Error(`The test has ended, so ${args[0]} is not run.`);
  const child = Bun.spawn([...args], {
    env: options.env,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  scope?.groups.add(child.pid);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    scope?.groups.delete(child.pid);
  }
}

/** Ends `scope`: kills every process group it still waits on, then waits for `body` for up to `budgetMs`. Answers whether
 * the body settled; one that did not can start nothing more. */
export async function endScope(
  scope: TestScope,
  body: Promise<unknown>,
  budgetMs: number,
): Promise<boolean> {
  scope.ended = true;
  for (const group of scope.groups)
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // The group has gone since its run last looked.
    }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    body.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), budgetMs);
    }),
  ]);
  clearTimeout(timer);
  return settled;
}

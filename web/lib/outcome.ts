/** What a call to rigd came back with, in a shape a Server Action can hand to the browser: a
 * thrown error would lose its code and hint on the way. */
export type Outcome<T> =
  { ok: true; value: T } | { ok: false; failure: Failure };
/** A refusal rigd answered with, or the transport failing before it could. */
export interface Failure {
  code: string;
  message: string;
  hint?: string;
  /** The Operation the refusal concerns, when rigd named one. */
  operationId?: string;
  /** For a config that failed validation: each field's problem, by its dotted path. */
  issues?: ConfigIssue[];
}
/** One field of rig.yaml and what is wrong with it. */
export interface ConfigIssue {
  /** Dotted path, such as services.web.ports.http. */
  path: string;
  message: string;
}
/** Pure: the field problems a refusal carried, each with a dotted path; malformed entries are left out. */
function issuesOf(details: unknown): ConfigIssue[] | undefined {
  const issues = (details as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues)) return undefined;
  const shaped = issues.flatMap((issue): ConfigIssue[] => {
    const { path, message } = (issue ?? {}) as {
      path?: unknown;
      message?: unknown;
    };
    return Array.isArray(path) && typeof message === "string"
      ? [{ path: path.map(String).join("."), message }]
      : [];
  });
  return shaped.length ? shaped : undefined;
}
export const succeeded = <T>(value: T): Outcome<T> => ({ ok: true, value });
export const refused = (failure: Failure): Outcome<never> => ({
  ok: false,
  failure,
});
/** Pure: the code, message and hint of any thrown value; Rig's errors carry all three. */
export function describeFailure(error: unknown): Failure {
  const known = error as {
    code?: unknown;
    message?: unknown;
    hint?: unknown;
    details?: unknown;
  } | null;
  const details = known?.details as { operationId?: unknown } | undefined;
  const issues = issuesOf(details);
  return {
    code: typeof known?.code === "string" ? known.code : "ERROR",
    message: typeof known?.message === "string" ? known.message : String(error),
    ...(typeof known?.hint === "string" ? { hint: known.hint } : {}),
    ...(typeof details?.operationId === "string"
      ? { operationId: details.operationId }
      : {}),
    ...(issues ? { issues } : {}),
  };
}
/** Runs one read and keeps its failure as data, so a page renders the refusal where the data would go. */
export async function attempt<T>(read: Promise<T>): Promise<Outcome<T>> {
  try {
    return succeeded(await read);
  } catch (error) {
    return refused(describeFailure(error));
  }
}

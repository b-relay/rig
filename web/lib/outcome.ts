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
  return {
    code: typeof known?.code === "string" ? known.code : "ERROR",
    message: typeof known?.message === "string" ? known.message : String(error),
    ...(typeof known?.hint === "string" ? { hint: known.hint } : {}),
    ...(typeof details?.operationId === "string"
      ? { operationId: details.operationId }
      : {}),
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

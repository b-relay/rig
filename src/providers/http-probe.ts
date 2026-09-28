/** How long one probe may wait for an answer. */
const PROBE_MS = 2_000;
/** The body of a GET that answers with a 2xx status; undefined when nothing answers in time, the connection fails, or
 * the status is another. Cancelled with `signal`. */
export async function probeText(
  url: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_MS)]),
    });
    return response.ok ? await response.text() : undefined;
  } catch {
    return undefined;
  }
}

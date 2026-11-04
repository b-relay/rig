/** What a control-plane request body may be. */
export interface BodyLimits {
  /** The most it may hold. */
  maxBytes: number;
  /** How long its whole upload may take, from when it is asked for. */
  deadlineMs: number;
}
/** Why a body was not received: not declared as JSON, over the limit, unfinished at the deadline, cut off by the caller,
 * or received whole but not JSON. */
export type BodyRefusal =
  "media-type" | "too-large" | "stalled" | "cut-off" | "malformed";
export type ReceivedBody = { value: unknown } | { refused: BodyRefusal };

/** The JSON document a request carries, or why it does not. Reads the body as it arrives, so an upload over the limit is
 * dropped having used at most the limit and one chunk of memory, whatever it declared. Rejects nothing. */
export async function receiveJson(
  request: Request,
  limits: BodyLimits,
): Promise<ReceivedBody> {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") return { refused: "media-type" };
  if (Number(request.headers.get("content-length")) > limits.maxBytes)
    return { refused: "too-large" };
  const chunks: Uint8Array[] = [];
  const received = await readChunks(request, limits, chunks);
  if (received !== undefined) return { refused: received };
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString()) };
  } catch {
    return { refused: "malformed" };
  }
}
/** Collects the body into `chunks`, answering why it stopped early. */
async function readChunks(
  request: Request,
  limits: BodyLimits,
  chunks: Uint8Array[],
): Promise<BodyRefusal | undefined> {
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const stalled = Promise.withResolvers<"stalled">();
  const deadline = setTimeout(
    () => stalled.resolve("stalled"),
    limits.deadlineMs,
  );
  try {
    let bytes = 0;
    for (;;) {
      const next = await Promise.race([reader.read(), stalled.promise]);
      if (next === "stalled") return "stalled";
      if (next.done) return undefined;
      bytes += next.value.length;
      if (bytes > limits.maxBytes) return "too-large";
      chunks.push(next.value);
    }
  } catch {
    return "cut-off";
  } finally {
    clearTimeout(deadline);
    void reader.cancel().catch(() => {});
  }
}

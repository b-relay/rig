import { unstable_rethrow } from "next/navigation";
import { describeFailure, type Outcome } from "../lib/outcome";

/** A layout's read with rigd's refusal kept as data, so the layout shows its code and hint (a
 * production build hides a thrown message behind generic text). Next's own control flow, such as
 * notFound(), still propagates. */
export async function settled<T>(read: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await read };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, failure: describeFailure(error) };
  }
}

import { z } from "zod";

/** A config map whose keys the author names, such as Services or ports. The record parser drops a __proto__ key without a
 * word, so it is refused by name before it gets there, as `<what> is not <keyKind>`. The refusal aborts, as a wrong type
 * does, so the cross-field rules never read a map the record parser did not check. */
export function keyedMap<K extends z.ZodType<string>, V extends z.ZodType>(
  key: K,
  value: V,
  keyKind: string,
) {
  return z
    .unknown()
    .refine(
      (map) =>
        typeof map !== "object" ||
        map === null ||
        !Object.hasOwn(map, "__proto__"),
      { message: `__proto__ is not ${keyKind}.`, abort: true },
    )
    .pipe(z.record(key, value));
}

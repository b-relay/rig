/** Puts `key` in `entries` as its most recent, and drops the least recently kept entry past `limit`. A Map keeps insertion
 * order, so keeping an entry each time it is used leaves the ones nothing uses any more first in line. */
export function keepRecent<Key, Value>(
  entries: Map<Key, Value>,
  key: Key,
  value: Value,
  limit: number,
): void {
  entries.delete(key);
  entries.set(key, value);
  if (entries.size > limit) entries.delete(entries.keys().next().value!);
}

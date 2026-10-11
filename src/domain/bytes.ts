/** Pure: a size as people read it, in powers of 1000 as Finder shows them: `812 B`, `4.2 kB`, `13 MB`, `1.6 GB`. One
 * decimal below 10 of a unit, none from 10 up. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  if (unit === 0) return `${bytes} B`;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

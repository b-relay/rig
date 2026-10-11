/** One day of the Activity timeline: its heading and its Operations, newest first. */
export interface ActivityDay<T> {
  label: string;
  operations: T[];
}
/** Pure: Operations as rigd lists them (oldest first) grouped by the local day they happened on,
 * newest day and newest Operation first. Today and yesterday go by those words; an instant that is
 * no date goes under "Undated", last. */
export function activityDays<T extends { occurredAt: string }>(
  operations: readonly T[],
  now: number,
): ActivityDay<T>[] {
  const days = new Map<string, T[]>();
  const order: string[] = [];
  for (const operation of [...operations].reverse()) {
    const label = dayLabel(operation.occurredAt, now);
    if (!days.has(label)) {
      days.set(label, []);
      order.push(label);
    }
    days.get(label)!.push(operation);
  }
  const dated = order.filter((label) => label !== "Undated");
  return [...dated, ...order.filter((label) => label === "Undated")].map(
    (label) => ({ label, operations: days.get(label)! }),
  );
}
const dayStart = (instant: Date) =>
  new Date(
    instant.getFullYear(),
    instant.getMonth(),
    instant.getDate(),
  ).getTime();
/** Pure: the heading of the local day an instant falls on. */
export function dayLabel(iso: string, now: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Undated";
  const days = Math.round(
    (dayStart(new Date(now)) - dayStart(date)) / 86_400_000,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(new Date(now).getFullYear() === date.getFullYear()
      ? {}
      : { year: "numeric" }),
  });
}

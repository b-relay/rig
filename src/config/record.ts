/** A config mapping as the rules read it, before or after the schema checked it. */
export type Fields = Readonly<Record<string, unknown>>;
export const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

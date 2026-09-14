import { relative, sep } from "node:path";
/** True when `child` sits strictly inside `parent`; both paths must already be absolute and normalized. */
export function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !path.startsWith(sep)
  );
}

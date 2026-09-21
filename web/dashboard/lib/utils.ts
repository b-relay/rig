import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins Tailwind class lists, letting a later utility override an earlier one of the same kind. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

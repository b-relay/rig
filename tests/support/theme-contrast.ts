import { readFileSync } from "node:fs";

/** One colour in linear sRGB, each channel 0..1, with its alpha. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
  alpha: number;
}
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const linear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

/** Pure: a CSS colour the theme writes (`#rrggbb` or `oklch(L C h [/ a%])`) in linear sRGB. */
export function parseColor(text: string): Rgb {
  const value = text.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return {
      r: linear(((n >> 16) & 255) / 255),
      g: linear(((n >> 8) & 255) / 255),
      b: linear((n & 255) / 255),
      alpha: 1,
    };
  }
  const oklch =
    /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)%)?\s*\)$/.exec(
      value,
    );
  if (!oklch) throw new Error(`Not a colour the theme test reads: ${value}`);
  const [L, C, h] = [1, 2, 3].map((index) => Number(oklch[index]));
  const a = C! * Math.cos((h! * Math.PI) / 180);
  const b = C! * Math.sin((h! * Math.PI) / 180);
  const l = (L! + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L! - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L! - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    alpha: oklch[4] === undefined ? 1 : Number(oklch[4]) / 100,
  };
}
const luminance = ({ r, g, b }: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** Pure: the WCAG contrast ratio of `foreground` over an opaque `background`. */
export function contrast(foreground: Rgb, background: Rgb): number {
  const [hi, lo] = [luminance(foreground), luminance(background)].sort(
    (x, y) => y - x,
  );
  return (hi! + 0.05) / (lo! + 0.05);
}
/** Splits `text` at commas that are not inside parentheses. */
function topLevelSplit(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}
export type Scheme = "light" | "dark";
/** Pure: every custom property the theme's `:root` blocks declare, resolved for one scheme:
 * `light-dark(A, B)` picks A or B, and `var(--x)` follows to its value. */
export function themeTokens(css: string, scheme: Scheme): Map<string, string> {
  const raw = new Map<string, string>();
  for (const block of css.matchAll(/:root\s*\{([^}]*)\}/g))
    for (const match of block[1]!.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g))
      raw.set(match[1]!, match[2]!.replace(/\s+/g, " ").trim());
  const resolve = (value: string, seen = 0): string => {
    if (seen > 10) throw new Error(`Token loop at ${value}`);
    const pick = /^light-dark\((.*)\)$/.exec(value);
    if (pick) {
      const [light, dark] = topLevelSplit(pick[1]!);
      return resolve(scheme === "light" ? light! : dark!, seen + 1);
    }
    const reference = /^var\(--([\w-]+)\)$/.exec(value);
    if (reference) {
      const next = raw.get(reference[1]!);
      if (!next) throw new Error(`Unknown token --${reference[1]}`);
      return resolve(next, seen + 1);
    }
    return value;
  };
  return new Map([...raw].map(([name, value]) => [name, resolve(value)]));
}
/** The site's own theme file. */
export const themeCss = () =>
  readFileSync(new URL("../../web/app/globals.css", import.meta.url), "utf8");

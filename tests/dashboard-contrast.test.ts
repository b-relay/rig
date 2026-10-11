import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  contrast,
  parseColor,
  themeCss,
  themeTokens,
  type Scheme,
} from "./support/theme-contrast";

/** Every ink the dashboard sets on a surface, as token pairs: the state tiles (word, dot and detail
 * on their tint), state dots and words on the card and the page, the quiet greys on the surfaces
 * they are used on, and links. Each must read at 4.5:1 in both schemes. */
const PAIRS: readonly (readonly [ink: string, surface: string])[] = [
  ["good", "good-fill"],
  ["warn", "warn-fill"],
  ["bad", "bad-fill"],
  ["idle", "muted"],
  ...["good", "warn", "bad", "idle", "busy"].flatMap(
    (ink) =>
      [
        [ink, "card"],
        [ink, "background"],
      ] as const,
  ),
  ["idle", "sidebar"],
  ["muted-foreground", "card"],
  ["muted-foreground", "background"],
  ["foreground", "card"],
  ["foreground", "background"],
  ["foreground", "muted"],
  ["foreground", "sidebar"],
  ["foreground", "good-fill"],
  ["foreground", "bad-fill"],
  ["link", "card"],
  ["link", "background"],
  ["primary-foreground", "primary"],
];

describe("theme contrast", () => {
  for (const scheme of ["light", "dark"] as Scheme[])
    test(`every ink reads at 4.5:1 on its surface in ${scheme}`, () => {
      const tokens = themeTokens(themeCss(), scheme);
      const short = PAIRS.flatMap(([ink, surface]) => {
        const ratio = contrast(
          parseColor(tokens.get(ink)!),
          parseColor(tokens.get(surface)!),
        );
        return ratio < 4.5 ? [`${ink} on ${surface}: ${ratio.toFixed(2)}`] : [];
      });
      expect(short).toEqual([]);
    });
  test("the colour maths agrees with known WCAG ratios", () => {
    const white = parseColor("#ffffff");
    expect(contrast(parseColor("#000000"), white)).toBeCloseTo(21, 1);
    expect(contrast(parseColor("#767676"), white)).toBeCloseTo(4.54, 1);
    expect(
      contrast(parseColor("oklch(1 0 0)"), parseColor("oklch(0 0 0)")),
    ).toBeCloseTo(21, 0);
  });
  test("light-dark and var() resolve per scheme", () => {
    const css =
      ":root { --a: light-dark(#ffffff, oklch(0.2 0.01 220)); --b: var(--a); }";
    expect(themeTokens(css, "light").get("b")).toBe("#ffffff");
    expect(themeTokens(css, "dark").get("b")).toBe("oklch(0.2 0.01 220)");
  });
});

/** Every .ts/.tsx source under the dashboard's app, components and lib. */
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

test("no text ink is faded with an opacity modifier, which the token pairs above would not cover", () => {
  const web = join(import.meta.dir, "..", "web");
  const faded = ["app", "components", "lib"]
    .flatMap((part) => sources(join(web, part)))
    .flatMap((path) =>
      [
        ...readFileSync(path, "utf8").matchAll(
          /text-(?:good|warn|bad|idle|busy|muted-foreground|link|foreground)\/\d+/g,
        ),
      ].map((match) => `${path}: ${match[0]}`),
    );
  expect(faded).toEqual([]);
});

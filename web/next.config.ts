import type { NextConfig } from "next";

/** The site is one private dashboard: every page reads rigd at request time, so nothing is prerendered. */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // A self-contained server (.next/standalone) that rigd runs with the Bun inside its own executable; the working Target
  // runs the same build. scripts/build-dashboard.sh assembles it.
  output: "standalone",
  // No page uses next/image, so the build carries no native image library and runs on either Mac architecture.
  images: { unoptimized: true },
  // The repository's own agent guidance lives at its root; next dev must not write another copy here.
  agentRules: false,
  // The daemon modules under src/ are imported straight from the repository, one level up.
  outputFileTracingRoot: `${__dirname}/..`,
  turbopack: { root: `${__dirname}/..` },
  experimental: {
    // A page seen in the last five minutes comes straight back when its tab is tapped again; the
    // live refresh replaces it as soon as rigd's record changes.
    staleTimes: { dynamic: 300 },
    // A navigation while the network is down waits for it to return instead of leaving the page
    // for the browser's error screen.
    useOffline: true,
  },
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "referrer-policy", value: "no-referrer" },
        { key: "x-content-type-options", value: "nosniff" },
        // The page controls this Host, so it never renders inside another page.
        { key: "x-frame-options", value: "DENY" },
      ],
    },
  ],
};
export default config;

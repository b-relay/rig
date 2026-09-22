import type { NextConfig } from "next";

/** The site is one private dashboard: every page reads rigd at request time, so nothing is prerendered. */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The repository's own agent guidance lives at its root; next dev must not write another copy here.
  agentRules: false,
  // The daemon modules under src/ are imported straight from the repository, one level up.
  outputFileTracingRoot: `${__dirname}/..`,
  turbopack: { root: `${__dirname}/..` },
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

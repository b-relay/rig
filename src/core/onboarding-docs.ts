import type { RigConfig } from "../schema/config.js"

export type OnboardingTopicId = "nextjs" | "vite" | "cli" | "convex"

export interface OnboardingFile {
  readonly path: string
  readonly content: string
  readonly executable?: boolean
}

export interface OnboardingRenderContext {
  readonly projectName: string
  readonly ports: Readonly<Record<string, number>>
}

export interface OnboardingProjectSpec {
  readonly rigConfig: RigConfig
  readonly files: readonly OnboardingFile[]
}

export interface OnboardingVariantDefinition {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly whenToUse: string
  readonly setupCommands: readonly string[]
  readonly devCommands: readonly string[]
  readonly prodCommands: readonly string[]
  readonly pitfalls: readonly string[]
  readonly agentGuidance: readonly string[]
  readonly defaultPorts: Readonly<Record<string, number>>
  readonly buildProject: (context: OnboardingRenderContext) => OnboardingProjectSpec
}

export interface OnboardingTopicDefinition {
  readonly id: OnboardingTopicId
  readonly title: string
  readonly summary: string
  readonly intro: string
  readonly variants: readonly OnboardingVariantDefinition[]
}

const DEFAULT_PROJECT_NAME = "my-app"

const jsonFile = (path: string, value: unknown): OnboardingFile => ({
  path,
  content: `${JSON.stringify(value, null, 2)}\n`,
})

const textFile = (path: string, content: string, executable = false): OnboardingFile => ({
  path,
  content,
  executable,
})

const parseArgScript = `
const readArg = (names, fallback) => {
  for (let index = 0; index < process.argv.length; index += 1) {
    const value = process.argv[index]
    if (!names.includes(value)) continue
    const next = process.argv[index + 1]
    if (typeof next === "string" && next.length > 0) return next
  }
  return fallback
}
`

const httpServiceScript = (label: string) => [
  parseArgScript.trim(),
  `const host = readArg(["--host", "--hostname"], "127.0.0.1")`,
  `const port = Number(readArg(["--port", "-p"], process.env.PORT ?? "0"))`,
  `const mode = readArg(["--mode"], "dev")`,
  `console.log("${label} service starting in " + mode + " mode")`,
  `const server = Bun.serve({`,
  `  hostname: host,`,
  `  port,`,
  `  fetch(req) {`,
  `    const url = new URL(req.url)`,
  `    if (url.pathname === "/health") return new Response("ok")`,
  `    return new Response("${label}:" + mode)`,
  `  },`,
  `})`,
  `console.log("${label} listening on " + host + ":" + port)`,
  `const timer = setInterval(() => console.log("${label} tick"), 250)`,
  `const shutdown = () => {`,
  `  clearInterval(timer)`,
  `  console.log("${label} stopping")`,
  `  server.stop(true)`,
  `  process.exit(0)`,
  `}`,
  `process.on("SIGTERM", shutdown)`,
  `process.on("SIGINT", shutdown)`,
  `await new Promise(() => {})`,
  ``,
].join("\n")

const nextBuildScript = [
  `import { mkdir } from "node:fs/promises"`,
  `await mkdir(".next", { recursive: true })`,
  `await Bun.write(".next/BUILD_ID", "dev-build\\n")`,
  `console.log("next build complete")`,
  ``,
].join("\n")

const viteBuildScript = [
  `import { mkdir } from "node:fs/promises"`,
  `await mkdir("dist", { recursive: true })`,
  `await Bun.write("dist/index.html", "<html><body>vite build</body></html>\\n")`,
  `console.log("vite build complete")`,
  ``,
].join("\n")

const convexLocalBackendScript = [
  `#!/usr/bin/env bun`,
  parseArgScript.trim(),
  `const host = readArg(["--interface"], "127.0.0.1")`,
  `const port = Number(readArg(["--port"], process.env.PORT ?? "0"))`,
  `const instanceName = readArg(["--instance-name"], "convex-local")`,
  `console.log("convex local backend starting " + instanceName)`,
  `const server = Bun.serve({`,
  `  hostname: host,`,
  `  port,`,
  `  fetch(req) {`,
  `    const url = new URL(req.url)`,
  `    if (url.pathname === "/version") {`,
  `      return Response.json({ instanceName, ok: true })`,
  `    }`,
  `    return new Response("convex:" + instanceName)`,
  `  },`,
  `})`,
  `console.log("convex local backend listening on " + host + ":" + port)`,
  `const timer = setInterval(() => console.log("convex tick " + instanceName), 250)`,
  `const shutdown = () => {`,
  `  clearInterval(timer)`,
  `  console.log("convex local backend stopping " + instanceName)`,
  `  server.stop(true)`,
  `  process.exit(0)`,
  `}`,
  `process.on("SIGTERM", shutdown)`,
  `process.on("SIGINT", shutdown)`,
  `await new Promise(() => {})`,
  ``,
].join("\n")

const convexStartScript = (
  projectName: string,
  ports: Readonly<Record<string, number>>,
): string => [
  `#!/usr/bin/env bash`,
  ``,
  `set -euo pipefail`,
  ``,
  `ENV_NAME="\${1:-}"`,
  `ROOT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"`,
  ``,
  `case "$ENV_NAME" in`,
  `  dev)`,
  `    PORT="${ports.convexDev ?? ports.dev}"`,
  `    INSTANCE_NAME="${projectName}-dev"`,
  `    ;;`,
  `  prod)`,
  `    PORT="${ports.convexProd ?? ports.prod}"`,
  `    INSTANCE_NAME="${projectName}-prod"`,
  `    ;;`,
  `  *)`,
  `    echo "Expected 'dev' or 'prod'." >&2`,
  `    exit 1`,
  `    ;;`,
  `esac`,
  ``,
  `if [[ ! -x "$ROOT_DIR/convex-local-backend" ]]; then`,
  `  echo "Missing executable: $ROOT_DIR/convex-local-backend" >&2`,
  `  exit 1`,
  `fi`,
  ``,
  `exec env -u TZ "$ROOT_DIR/convex-local-backend" \\`,
  `  --interface 127.0.0.1 \\`,
  `  --instance-name "$INSTANCE_NAME" \\`,
  `  --port "$PORT"`,
  ``,
].join("\n")

const convexPushScript = [
  `#!/usr/bin/env bash`,
  ``,
  `set -euo pipefail`,
  ``,
  `ENV_NAME="\${1:-dev}"`,
  `ONCE_FLAG="\${2:-}"`,
  `echo "convex push \${ENV_NAME} \${ONCE_FLAG}"`,
  ``,
].join("\n")

const cliEntrypointScript = (label: string) => [
  `console.log("${label} cli ready")`,
  `console.log(process.argv.slice(2).join(" "))`,
  ``,
].join("\n")

const packageJson = (
  name: string,
  scripts: Readonly<Record<string, string>>,
): OnboardingFile =>
  jsonFile("package.json", {
    name,
    private: true,
    version: "0.0.0",
    scripts,
  })

const nextStandaloneProject = ({ projectName, ports }: OnboardingRenderContext): OnboardingProjectSpec => ({
  rigConfig: {
    name: projectName,
    description: "Next.js app managed by rig.",
    version: "0.1.0",
    environments: {
      dev: {
        services: [
          {
            name: "web",
            type: "server",
            command: `bun run dev -- --hostname 127.0.0.1 --port ${ports.dev}`,
            port: ports.dev,
            healthCheck: `http://127.0.0.1:${ports.dev}/health`,
            readyTimeout: 10,
          },
        ],
      },
      prod: {
        deployBranch: "main",
        services: [
          {
            name: "web",
            type: "server",
            command: `bun run start -- --hostname 127.0.0.1 --port ${ports.prod}`,
            port: ports.prod,
            healthCheck: `http://127.0.0.1:${ports.prod}/health`,
            readyTimeout: 10,
            hooks: {
              preStart: "bun run build",
            },
          },
        ],
      },
    },
  },
  files: [
    packageJson(projectName, {
      dev: `bun run scripts/next-dev.ts --mode dev`,
      build: "bun run scripts/next-build.ts",
      start: `bun run scripts/next-start.ts --mode prod`,
      typecheck: "echo typecheck",
      lint: "echo lint",
      test: "echo test",
    }),
    textFile("scripts/next-dev.ts", httpServiceScript("next-dev")),
    textFile("scripts/next-start.ts", httpServiceScript("next-start")),
    textFile("scripts/next-build.ts", nextBuildScript),
    textFile("README.md", "# Next.js onboarding fixture\n"),
  ],
})

const viteStandaloneProject = ({ projectName, ports }: OnboardingRenderContext): OnboardingProjectSpec => ({
  rigConfig: {
    name: projectName,
    description: "Vite web app managed by rig.",
    version: "0.1.0",
    environments: {
      dev: {
        services: [
          {
            name: "web",
            type: "server",
            command: `bun run dev -- --host 127.0.0.1 --port ${ports.dev}`,
            port: ports.dev,
            healthCheck: `http://127.0.0.1:${ports.dev}/health`,
            readyTimeout: 10,
          },
        ],
      },
      prod: {
        deployBranch: "main",
        services: [
          {
            name: "web",
            type: "server",
            command: `bun run preview -- --host 127.0.0.1 --port ${ports.prod}`,
            port: ports.prod,
            healthCheck: `http://127.0.0.1:${ports.prod}/health`,
            readyTimeout: 10,
            hooks: {
              preStart: "bun run build",
            },
          },
        ],
      },
    },
  },
  files: [
    packageJson(projectName, {
      dev: "bun run scripts/vite-dev.ts --mode dev",
      build: "bun run scripts/vite-build.ts",
      preview: "bun run scripts/vite-preview.ts --mode prod",
      typecheck: "echo typecheck",
      lint: "echo lint",
      test: "echo test",
    }),
    textFile("scripts/vite-dev.ts", httpServiceScript("vite-dev")),
    textFile("scripts/vite-preview.ts", httpServiceScript("vite-preview")),
    textFile("scripts/vite-build.ts", viteBuildScript),
    textFile("README.md", "# Vite onboarding fixture\n"),
  ],
})

const viteSharedBackendProject = ({ projectName, ports }: OnboardingRenderContext): OnboardingProjectSpec => ({
  rigConfig: {
    name: projectName,
    description: "Vite frontend plus shared backend managed by rig.",
    version: "0.1.0",
    environments: {
      dev: {
        services: [
          {
            name: "api",
            type: "server",
            command: `bun run api:dev -- --host 127.0.0.1 --port ${ports.apiDev}`,
            port: ports.apiDev,
            healthCheck: `http://127.0.0.1:${ports.apiDev}/health`,
            readyTimeout: 10,
          },
          {
            name: "web",
            type: "server",
            command: `bun run dev -- --host 127.0.0.1 --port ${ports.dev}`,
            port: ports.dev,
            healthCheck: `http://127.0.0.1:${ports.dev}/health`,
            readyTimeout: 10,
            dependsOn: ["api"],
          },
        ],
      },
      prod: {
        deployBranch: "main",
        services: [
          {
            name: "api",
            type: "server",
            command: `bun run api:start -- --host 127.0.0.1 --port ${ports.apiProd}`,
            port: ports.apiProd,
            healthCheck: `http://127.0.0.1:${ports.apiProd}/health`,
            readyTimeout: 10,
          },
          {
            name: "web",
            type: "server",
            command: `bun run preview -- --host 127.0.0.1 --port ${ports.prod}`,
            port: ports.prod,
            healthCheck: `http://127.0.0.1:${ports.prod}/health`,
            readyTimeout: 10,
            dependsOn: ["api"],
            hooks: {
              preStart: "bun run build",
            },
          },
        ],
      },
    },
  },
  files: [
    packageJson(projectName, {
      dev: "bun run scripts/vite-dev.ts --mode dev",
      build: "bun run scripts/vite-build.ts",
      preview: "bun run scripts/vite-preview.ts --mode prod",
      "api:dev": "bun run scripts/api-dev.ts --mode dev",
      "api:start": "bun run scripts/api-start.ts --mode prod",
      typecheck: "echo typecheck",
      lint: "echo lint",
      test: "echo test",
    }),
    textFile("scripts/vite-dev.ts", httpServiceScript("vite-dev")),
    textFile("scripts/vite-preview.ts", httpServiceScript("vite-preview")),
    textFile("scripts/vite-build.ts", viteBuildScript),
    textFile("scripts/api-dev.ts", httpServiceScript("api-dev")),
    textFile("scripts/api-start.ts", httpServiceScript("api-start")),
    textFile("README.md", "# Vite shared backend onboarding fixture\n"),
  ],
})

const cliStandaloneProject = ({ projectName }: OnboardingRenderContext): OnboardingProjectSpec => ({
  rigConfig: {
    name: projectName,
    description: "CLI app managed by rig.",
    version: "0.1.0",
    environments: {
      dev: {
        services: [
          {
            name: "tool",
            type: "bin",
            entrypoint: "bun run bin/tool.ts",
          },
        ],
      },
      prod: {
        deployBranch: "main",
        services: [
          {
            name: "tool",
            type: "bin",
            build: "bun build --compile bin/tool.ts --outfile dist/tool",
            entrypoint: "dist/tool",
          },
        ],
      },
    },
  },
  files: [
    packageJson(projectName, {
      typecheck: "echo typecheck",
      lint: "echo lint",
      test: "echo test",
    }),
    textFile("bin/tool.ts", cliEntrypointScript("tool")),
    textFile("README.md", "# CLI onboarding fixture\n"),
  ],
})

const cliSharedBackendProject = ({ projectName, ports }: OnboardingRenderContext): OnboardingProjectSpec => ({
  rigConfig: {
    name: projectName,
    description: "CLI app plus shared backend managed by rig.",
    version: "0.1.0",
    environments: {
      dev: {
        services: [
          {
            name: "api",
            type: "server",
            command: `bun run api:dev -- --host 127.0.0.1 --port ${ports.apiDev}`,
            port: ports.apiDev,
            healthCheck: `http://127.0.0.1:${ports.apiDev}/health`,
            readyTimeout: 10,
          },
          {
            name: "tool",
            type: "bin",
            entrypoint: "bun run bin/tool.ts",
          },
        ],
      },
      prod: {
        deployBranch: "main",
        services: [
          {
            name: "api",
            type: "server",
            command: `bun run api:start -- --host 127.0.0.1 --port ${ports.apiProd}`,
            port: ports.apiProd,
            healthCheck: `http://127.0.0.1:${ports.apiProd}/health`,
            readyTimeout: 10,
          },
          {
            name: "tool",
            type: "bin",
            build: "bun build --compile bin/tool.ts --outfile dist/tool",
            entrypoint: "dist/tool",
          },
        ],
      },
    },
  },
  files: [
    packageJson(projectName, {
      "api:dev": "bun run scripts/api-dev.ts --mode dev",
      "api:start": "bun run scripts/api-start.ts --mode prod",
      typecheck: "echo typecheck",
      lint: "echo lint",
      test: "echo test",
    }),
    textFile("bin/tool.ts", cliEntrypointScript("tool")),
    textFile("scripts/api-dev.ts", httpServiceScript("api-dev")),
    textFile("scripts/api-start.ts", httpServiceScript("api-start")),
    textFile("README.md", "# CLI shared backend onboarding fixture\n"),
  ],
})

const convexStandaloneProject = ({ projectName, ports }: OnboardingRenderContext): OnboardingProjectSpec => ({
  rigConfig: {
    name: projectName,
    description: "Managed local Convex backend under rig.",
    version: "0.1.0",
    environments: {
      dev: {
        services: [
          {
            name: "convex",
            type: "server",
            command: "./scripts/start-convex.sh dev",
            port: ports.dev,
            healthCheck: `http://127.0.0.1:${ports.dev}/version`,
            readyTimeout: 10,
            hooks: {
              postStart: "bun run convex:push:dev",
            },
          },
        ],
      },
      prod: {
        deployBranch: "main",
        services: [
          {
            name: "convex",
            type: "server",
            command: "./scripts/start-convex.sh prod",
            port: ports.prod,
            healthCheck: `http://127.0.0.1:${ports.prod}/version`,
            readyTimeout: 10,
            hooks: {
              postStart: "bun run convex:push:prod",
            },
          },
        ],
      },
    },
  },
  files: [
    packageJson(projectName, {
      "convex:push:dev": "./scripts/convex.sh dev --once",
      "convex:push:prod": "./scripts/convex.sh prod --once",
      typecheck: "echo typecheck",
      lint: "echo lint",
      test: "echo test",
    }),
    textFile("convex-local-backend", convexLocalBackendScript, true),
    textFile("scripts/start-convex.sh", convexStartScript(projectName, ports), true),
    textFile("scripts/convex.sh", convexPushScript, true),
    textFile("README.md", "# Convex onboarding fixture\n"),
  ],
})

const convexViteProject = ({ projectName, ports }: OnboardingRenderContext): OnboardingProjectSpec => ({
  rigConfig: {
    name: projectName,
    description: "Convex backend with Vite frontend under rig.",
    version: "0.1.0",
    environments: {
      dev: {
        services: [
          {
            name: "convex",
            type: "server",
            command: "./scripts/start-convex.sh dev",
            port: ports.convexDev,
            healthCheck: `http://127.0.0.1:${ports.convexDev}/version`,
            readyTimeout: 10,
            hooks: {
              postStart: "bun run convex:push:dev",
            },
          },
          {
            name: "web",
            type: "server",
            command: `bun run dev -- --host 127.0.0.1 --port ${ports.webDev}`,
            port: ports.webDev,
            healthCheck: `http://127.0.0.1:${ports.webDev}/health`,
            readyTimeout: 10,
            dependsOn: ["convex"],
          },
        ],
      },
      prod: {
        deployBranch: "main",
        services: [
          {
            name: "convex",
            type: "server",
            command: "./scripts/start-convex.sh prod",
            port: ports.convexProd,
            healthCheck: `http://127.0.0.1:${ports.convexProd}/version`,
            readyTimeout: 10,
            hooks: {
              postStart: "bun run convex:push:prod",
            },
          },
          {
            name: "web",
            type: "server",
            command: `bun run preview -- --host 127.0.0.1 --port ${ports.webProd}`,
            port: ports.webProd,
            healthCheck: `http://127.0.0.1:${ports.webProd}/health`,
            readyTimeout: 10,
            dependsOn: ["convex"],
            hooks: {
              preStart: "bun run build",
            },
          },
        ],
      },
    },
  },
  files: [
    packageJson(projectName, {
      "convex:push:dev": "./scripts/convex.sh dev --once",
      "convex:push:prod": "./scripts/convex.sh prod --once",
      dev: "bun run scripts/vite-dev.ts --mode dev",
      build: "bun run scripts/vite-build.ts",
      preview: "bun run scripts/vite-preview.ts --mode prod",
      typecheck: "echo typecheck",
      lint: "echo lint",
      test: "echo test",
    }),
    textFile("convex-local-backend", convexLocalBackendScript, true),
    textFile("scripts/start-convex.sh", convexStartScript(projectName, ports), true),
    textFile("scripts/convex.sh", convexPushScript, true),
    textFile("scripts/vite-dev.ts", httpServiceScript("vite-dev")),
    textFile("scripts/vite-preview.ts", httpServiceScript("vite-preview")),
    textFile("scripts/vite-build.ts", viteBuildScript),
    textFile("README.md", "# Convex + Vite onboarding fixture\n"),
  ],
})

const convexCliProject = ({ projectName, ports }: OnboardingRenderContext): OnboardingProjectSpec => ({
  rigConfig: {
    name: projectName,
    description: "Convex backend with CLI tool under rig.",
    version: "0.1.0",
    environments: {
      dev: {
        services: [
          {
            name: "convex",
            type: "server",
            command: "./scripts/start-convex.sh dev",
            port: ports.convexDev,
            healthCheck: `http://127.0.0.1:${ports.convexDev}/version`,
            readyTimeout: 10,
            hooks: {
              postStart: "bun run convex:push:dev",
            },
          },
          {
            name: "tool",
            type: "bin",
            entrypoint: "bun run bin/tool.ts",
          },
        ],
      },
      prod: {
        deployBranch: "main",
        services: [
          {
            name: "convex",
            type: "server",
            command: "./scripts/start-convex.sh prod",
            port: ports.convexProd,
            healthCheck: `http://127.0.0.1:${ports.convexProd}/version`,
            readyTimeout: 10,
            hooks: {
              postStart: "bun run convex:push:prod",
            },
          },
          {
            name: "tool",
            type: "bin",
            build: "bun build --compile bin/tool.ts --outfile dist/tool",
            entrypoint: "dist/tool",
          },
        ],
      },
    },
  },
  files: [
    packageJson(projectName, {
      "convex:push:dev": "./scripts/convex.sh dev --once",
      "convex:push:prod": "./scripts/convex.sh prod --once",
      typecheck: "echo typecheck",
      lint: "echo lint",
      test: "echo test",
    }),
    textFile("convex-local-backend", convexLocalBackendScript, true),
    textFile("scripts/start-convex.sh", convexStartScript(projectName, ports), true),
    textFile("scripts/convex.sh", convexPushScript, true),
    textFile("bin/tool.ts", cliEntrypointScript("convex-tool")),
    textFile("README.md", "# Convex + CLI onboarding fixture\n"),
  ],
})

const renderRigConfig = (variant: OnboardingVariantDefinition): string =>
  JSON.stringify(
    variant.buildProject({
      projectName: DEFAULT_PROJECT_NAME,
      ports: variant.defaultPorts,
    }).rigConfig,
    null,
    2,
  )

const commonAgentGuidance = (serviceExamples: readonly string[]): readonly string[] => [
  "Use rig for any long-running lifecycle action once the app is rig-managed.",
  `Use ${serviceExamples.join(", ")} instead of running raw dev server commands yourself.`,
  "Do not tell AI agents to run bun run dev, npm run dev, next dev, vite dev, or backend server commands directly for ongoing service management.",
  "One-shot commands are still fine outside rig: typecheck, lint, tests, builds, and other non-running tasks.",
]

const ONBOARDING_TOPIC_NOTES: readonly string[] = [
  "The ports shown below are example localhost ports only. Pick any free localhost port for each service and environment.",
  "These guides use Bun in commands and hooks because this repo is Bun-first. If your project uses npm, pnpm, or yarn, use that instead.",
  "The sample fixtures behind these docs implement /health or /version so the examples are runnable. In a real app, point healthCheck at a real endpoint your service actually serves.",
  "Dependencies are assumed to already be installed or to be handled by project-specific bootstrap scripts or hooks.",
]

export const ONBOARDING_TOPICS: readonly OnboardingTopicDefinition[] = [
  {
    id: "nextjs",
    title: "Next.js",
    summary: "Standalone Next.js app managed through rig in dev and prod.",
    intro:
      "Use this when you have a single Next.js web app and want rig to own both dev and prod lifecycle. The recommended pattern is one web service per environment, with prod running `bun run build` in a preStart hook and then `bun run start`.",
    variants: [
      {
        id: "nextjs-standalone",
        title: "Standalone Next.js app",
        summary: "One web service, separate dev and prod commands.",
        whenToUse: "Use this when the project is just a Next.js web app with no extra backend inside the same rig project.",
        setupCommands: ["rig init my-app --path ."],
        devCommands: [
          "rig deploy my-app dev",
          "rig status my-app dev",
          "rig logs my-app dev --follow",
        ],
        prodCommands: [
          "git add . && git commit -m 'feat: release'",
          "rig deploy my-app prod --bump minor",
          "rig status my-app prod",
        ],
        pitfalls: [
          "Bind Next.js to 127.0.0.1, not 0.0.0.0.",
          "Keep build in the prod preStart hook so dev stays fast.",
          "The sample fixture exposes /health. In a real Next.js app, point healthCheck at a real endpoint you already serve.",
        ],
        agentGuidance: commonAgentGuidance([
          "`rig deploy my-app dev`",
          "`rig logs my-app dev --follow`",
          "`rig deploy my-app prod --bump minor`",
        ]),
        defaultPorts: { dev: 43001, prod: 43002 },
        buildProject: nextStandaloneProject,
      },
    ],
  },
  {
    id: "vite",
    title: "Vite",
    summary: "Vite web apps, including standalone and shared-backend layouts.",
    intro:
      "Use this when the frontend is a Vite app. The standalone pattern uses a Bun-driven dev script in dev and `vite preview`-style behavior in prod after a build. If the Vite app ships with a backend, put both services in the same rig project and let rig own startup ordering.",
    variants: [
      {
        id: "vite-standalone",
        title: "Standalone Vite web app",
        summary: "One Vite web service managed by rig.",
        whenToUse: "Use this when Vite is the whole app and there is no separate backend service in the same rig project.",
        setupCommands: ["rig init my-app --path ."],
        devCommands: [
          "rig deploy my-app dev",
          "rig logs my-app dev --follow",
        ],
        prodCommands: [
          "git add . && git commit -m 'feat: release'",
          "rig deploy my-app prod --bump minor",
          "rig status my-app prod",
        ],
        pitfalls: [
          "Use `vite preview` for the managed prod service instead of running `vite dev` in prod.",
          "Bind Vite to 127.0.0.1 explicitly.",
          "Build in prod preStart so the preview server has fresh output.",
          "The sample fixture exposes /health. Replace it with your app's real ready endpoint if needed.",
        ],
        agentGuidance: commonAgentGuidance([
          "`rig deploy my-app dev`",
          "`rig logs my-app dev --follow`",
          "`rig deploy my-app prod --bump minor`",
        ]),
        defaultPorts: { dev: 45173, prod: 44173 },
        buildProject: viteStandaloneProject,
      },
      {
        id: "vite-shared-backend",
        title: "Vite app with a shared backend",
        summary: "A frontend service plus a backend service in one rig project.",
        whenToUse: "Use this when the frontend and backend live together and should start together under rig.",
        setupCommands: ["rig init my-app --path ."],
        devCommands: [
          "rig deploy my-app dev",
          "rig status my-app dev",
          "rig logs my-app dev --follow",
        ],
        prodCommands: [
          "git add . && git commit -m 'feat: release'",
          "rig deploy my-app prod --bump minor",
          "rig status my-app prod",
        ],
        pitfalls: [
          "Make the web service depend on the backend service so the frontend only starts after the backend is healthy.",
          "Keep the frontend and backend on separate localhost ports.",
          "Use rig status to confirm both services came up, not just the frontend.",
          "The sample fixture uses /health on both services; use real endpoints in a real project.",
        ],
        agentGuidance: commonAgentGuidance([
          "`rig deploy my-app dev`",
          "`rig status my-app dev`",
          "`rig deploy my-app prod --bump minor`",
        ]),
        defaultPorts: { apiDev: 45201, apiProd: 44201, dev: 45202, prod: 44202 },
        buildProject: viteSharedBackendProject,
      },
    ],
  },
  {
    id: "cli",
    title: "CLI",
    summary: "CLI/bin apps, standalone or paired with a shared backend.",
    intro:
      "Use this when the main product surface is a command-line tool. In dev, a command-style `bin` entrypoint is fine. In prod, prefer a compiled binary build with a file entrypoint so rig installs a concrete artifact into ~/.local/bin.",
    variants: [
      {
        id: "cli-standalone",
        title: "Standalone CLI app",
        summary: "A single bin service installed by rig.",
        whenToUse: "Use this when the project is just a CLI tool and rig should own install/uninstall across dev and prod.",
        setupCommands: ["rig init my-app --path ."],
        devCommands: [
          "rig start my-app dev",
          "rig stop my-app dev",
        ],
        prodCommands: [
          "git add . && git commit -m 'feat: release'",
          "rig deploy my-app prod --bump minor",
          "rig stop my-app prod",
        ],
        pitfalls: [
          "Use a `bin` service, not a `server`, for tools that should be installed into ~/.local/bin.",
          "A command-string entrypoint is fine in dev, but prod should usually build a binary and point entrypoint at the built file.",
          "Use `rig stop` to uninstall the managed shim cleanly.",
        ],
        agentGuidance: commonAgentGuidance([
          "`rig start my-app dev`",
          "`rig stop my-app dev`",
          "`rig deploy my-app prod --bump minor`",
        ]),
        defaultPorts: {},
        buildProject: cliStandaloneProject,
      },
      {
        id: "cli-shared-backend",
        title: "CLI app with a shared backend",
        summary: "A bin service plus a backend service in one rig project.",
        whenToUse: "Use this when the CLI talks to a backend that you also want rig to manage locally.",
        setupCommands: ["rig init my-app --path ."],
        devCommands: [
          "rig start my-app dev",
          "rig status my-app dev",
          "rig stop my-app dev",
        ],
        prodCommands: [
          "git add . && git commit -m 'feat: release'",
          "rig deploy my-app prod --bump minor",
          "rig status my-app prod",
        ],
        pitfalls: [
          "The backend should be a `server` service and the CLI should remain a `bin` service.",
          "Let rig start the backend before installing the CLI in mixed environments.",
          "Do not model the CLI as a server just to share an environment with the backend.",
          "For prod, compile the CLI and install the built binary instead of leaving it as a script command.",
        ],
        agentGuidance: commonAgentGuidance([
          "`rig start my-app dev`",
          "`rig status my-app dev`",
          "`rig deploy my-app prod --bump minor`",
        ]),
        defaultPorts: { apiDev: 45301, apiProd: 44301 },
        buildProject: cliSharedBackendProject,
      },
    ],
  },
  {
    id: "convex",
    title: "Convex",
    summary: "Managed local Convex backend flows under rig, standalone or paired with Vite/CLI apps.",
    intro:
      "Use this when rig should own a local Convex backend lifecycle. These guides use a realistic local backend pattern: a local backend executable launched through a wrapper script, `/version` health checks, and postStart push hooks. `convex` here means the local managed backend flow under rig, not a hosted cloud deployment.",
    variants: [
      {
        id: "convex-standalone",
        title: "Standalone managed Convex backend",
        summary: "One local Convex backend service with codegen before start.",
        whenToUse: "Use this when the local backend itself is the main thing rig should manage.",
        setupCommands: ["rig init my-app --path ."],
        devCommands: [
          "rig deploy my-app dev",
          "rig logs my-app dev --follow",
        ],
        prodCommands: [
          "git add . && git commit -m 'feat: release'",
          "rig deploy my-app prod --bump minor",
          "rig status my-app prod",
        ],
        pitfalls: [
          "Use a wrapper script around the local backend executable so env-specific ports and instance names stay in one place.",
          "Use `/version` as the healthCheck only if your local Convex backend really serves it.",
          "Keep the backend localhost-only and use separate ports and instance names for dev and prod.",
        ],
        agentGuidance: commonAgentGuidance([
          "`rig deploy my-app dev`",
          "`rig logs my-app dev --follow`",
          "`rig deploy my-app prod --bump minor`",
        ]),
        defaultPorts: { dev: 45401, prod: 44401 },
        buildProject: convexStandaloneProject,
      },
      {
        id: "convex-vite",
        title: "Convex backend with a Vite frontend",
        summary: "A local Convex backend plus a Vite web service managed together.",
        whenToUse: "Use this when Vite and the local Convex backend live in one project and should start together.",
        setupCommands: ["rig init my-app --path ."],
        devCommands: [
          "rig deploy my-app dev",
          "rig status my-app dev",
          "rig logs my-app dev --follow",
        ],
        prodCommands: [
          "git add . && git commit -m 'feat: release'",
          "rig deploy my-app prod --bump minor",
          "rig status my-app prod",
        ],
        pitfalls: [
          "Make the web service depend on the Convex service so the frontend starts after backend health is green.",
          "Use postStart push hooks for the Convex sidecar flow, not a fake long-running `bunx convex` service.",
          "Use different ports for Convex and the frontend in each environment.",
        ],
        agentGuidance: commonAgentGuidance([
          "`rig deploy my-app dev`",
          "`rig status my-app dev`",
          "`rig deploy my-app prod --bump minor`",
        ]),
        defaultPorts: { convexDev: 45411, convexProd: 44411, webDev: 45412, webProd: 44412 },
        buildProject: convexViteProject,
      },
      {
        id: "convex-cli",
        title: "Convex backend with a CLI app",
        summary: "A local Convex backend plus a CLI/bin service managed together.",
        whenToUse: "Use this when a CLI tool should be installed by rig while a local Convex backend runs beside it.",
        setupCommands: ["rig init my-app --path ."],
        devCommands: [
          "rig start my-app dev",
          "rig status my-app dev",
          "rig stop my-app dev",
        ],
        prodCommands: [
          "git add . && git commit -m 'feat: release'",
          "rig deploy my-app prod --bump minor",
          "rig status my-app prod",
        ],
        pitfalls: [
          "Keep Convex as the server service and the CLI as a bin service.",
          "Compile the CLI for prod instead of leaving it as a script-style bin entrypoint.",
          "Use rig logs on the backend service to debug local backend failures.",
        ],
        agentGuidance: commonAgentGuidance([
          "`rig start my-app dev`",
          "`rig status my-app dev`",
          "`rig deploy my-app prod --bump minor`",
        ]),
        defaultPorts: { convexDev: 45421, convexProd: 44421 },
        buildProject: convexCliProject,
      },
    ],
  },
] as const

export const ONBOARDING_TOPIC_MAP = new Map(
  ONBOARDING_TOPICS.map((topic) => [topic.id, topic] as const),
)

export const renderOnboardingTopicList = (): readonly string[] => [
  "Onboarding Docs",
  "  These are rig-first starter recipes for common app shapes.",
  "  Example ports are just examples, and Bun is only the example package manager.",
  ...ONBOARDING_TOPICS.map((topic) => `  ${topic.id.padEnd(8)} ${topic.summary}`),
]

export const renderOnboardingTopic = (topic: OnboardingTopicDefinition): string => {
  const lines: string[] = [
    topic.title,
    "",
    topic.intro,
    "",
    "Important Notes:",
    ...ONBOARDING_TOPIC_NOTES.map((note) => `  - ${note}`),
  ]

  for (const variant of topic.variants) {
    lines.push(
      "",
      `Variant: ${variant.title}`,
      `When to Use: ${variant.whenToUse}`,
      "",
      variant.summary,
      "",
      "Setup:",
      ...variant.setupCommands.map((command) => `  ${command}`),
      "",
      "rig.json:",
      ...renderRigConfig(variant).split("\n").map((line) => `  ${line}`),
      "",
      "Dev:",
      ...variant.devCommands.map((command) => `  ${command}`),
      "",
      "Prod:",
      ...variant.prodCommands.map((command) => `  ${command}`),
      "",
      "Pitfalls:",
      ...variant.pitfalls.map((item) => `  - ${item}`),
      "",
      "Agent Guidance:",
      ...variant.agentGuidance.map((item) => `  - ${item}`),
    )
  }

  return lines.join("\n")
}

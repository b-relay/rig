import { join } from "node:path";
import {
  createCaddyRouter,
  type Router,
} from "../../src/providers/caddy-router";

/** Publishes nothing and holds no route: publication for a test about something else. */
export function noRoutes(): Router {
  return {
    async apply() {},
    async remove() {},
    async withheld() {
      return [];
    },
    async checkpoint(key) {
      return { key, value: null };
    },
    async restore() {},
  };
}

/** The real Caddy router over a Caddyfile under `root`, whose every reload succeeds without running Caddy. */
export function unreloadedCaddy(root: string): Router {
  return createCaddyRouter({
    caddyfile: join(root, "Caddyfile"),
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
}

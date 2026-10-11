import { z } from "zod";
import type { CommandRunner, HostAddress } from "./contracts";

/** Where the Tailscale CLI lives on a Mac: on PATH, from Homebrew, or inside the App Store app. rigd runs with a short PATH
 * under launchd, so the fixed paths are tried too. */
export const TAILSCALE_COMMANDS: readonly string[] = [
  "tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];
const ipv4 = z.ipv4();

/** This Mac's Tailscale IPv4 address, from `tailscale ip -4`: the first CLI that answers with an IPv4 address wins.
 * Undefined when none does (Tailscale is not installed, not running, or logged out). */
export function createTailscaleAddress(options: {
  readonly run: CommandRunner;
  readonly commands?: readonly string[];
  readonly timeoutMs?: number;
}): HostAddress {
  return {
    async ipv4() {
      for (const command of options.commands ?? TAILSCALE_COMMANDS) {
        const result = await options
          .run({
            command: [command, "ip", "-4"],
            timeoutMs: options.timeoutMs ?? 3000,
          })
          .catch(() => undefined);
        if (!result || result.exitCode !== 0) continue;
        const address = result.stdout
          .split(/\s+/)
          .find((word) => ipv4.safeParse(word).success);
        if (address) return address;
      }
      return undefined;
    },
  };
}

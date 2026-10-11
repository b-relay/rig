import { readFile } from "node:fs/promises";
import { RigError } from "../domain/errors";
import { normalizeToken, proxyPaths } from "../domain/managed-proxy";
import { inspectProxyToken } from "./proxy-token";

/** The stored DNS provider token (`rig proxy token`), read for one request and never kept, logged or returned. Fails
 * DNS_TOKEN, saying what is wrong with the file but nothing of what is in it. */
export async function readDnsToken(root: string): Promise<string> {
  const path = proxyPaths(root).token;
  const store =
    "Create a Cloudflare API token with Zone:Zone:Read and Zone:DNS:Edit on your zone, copy it, and run: pbpaste | rig proxy token";
  const state = await inspectProxyToken(root);
  const refuse = (message: string, hint = store) =>
    new RigError("DNS_TOKEN", message, hint, { path });
  switch (state.state) {
    case "missing":
      throw refuse(`No DNS API token is stored at ${path}.`);
    case "unreadable":
      throw refuse(
        `The DNS API token at ${path} cannot be read.`,
        `Check the file's permissions, or store it again. ${store}`,
      );
    case "malformed":
      throw refuse(
        `The DNS API token at ${path} is malformed.`,
        `Store it again. ${store}`,
      );
    case "exposed":
      throw refuse(
        `The DNS API token at ${path} is readable by others (mode ${state.mode.toString(8)}).`,
        `Run chmod 600 ${path}, or store it again with rig proxy token.`,
      );
    case "foreign":
      throw refuse(
        `The DNS API token at ${path} belongs to another user.`,
        `Store it again as yourself. ${store}`,
      );
  }
  try {
    return normalizeToken(await readFile(path, "utf8"));
  } catch {
    throw refuse(
      `The DNS API token at ${path} cannot be read.`,
      `Store it again. ${store}`,
    );
  }
}

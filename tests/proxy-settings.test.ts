import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProxySettings } from "../src/adapters/proxy-settings";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function rootWith(config: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rig-proxy-settings-"));
  roots.push(root);
  await writeFile(join(root, "config.yaml"), config);
  return root;
}

test("rig proxy reload reads Host config afresh and names what is wrong with an edit that does not validate", async () => {
  expect(
    await readProxySettings(
      await rootWith(
        "proxy:\n  caddy: /usr/local/bin/caddy\n  routes:\n    grafana.example.com: 3000\n",
      ),
    ),
  ).toMatchObject({ routes: { "grafana.example.com": 3000 } });
  const invalid = await rootWith(
    'proxy:\n  caddy: /usr/local/bin/caddy\n  tls:\n    ca: "https://acme.test/{$NAME}"\n  site: [encode gzip]\n',
  );
  await expect(readProxySettings(invalid)).rejects.toMatchObject({
    code: "PROXY_CONFIG",
    message: expect.stringMatching(
      /^Host config cannot be read: .*proxy\.tls\.ca/,
    ),
    hint: expect.stringContaining("last accepted"),
  });
  await expect(
    readProxySettings(await rootWith("proxy: [\n")),
  ).rejects.toMatchObject({
    code: "PROXY_CONFIG",
    message: expect.stringContaining("Host config cannot be read"),
  });
  await expect(
    readProxySettings(await rootWith("providers:\n  caddy: {}\n")),
  ).rejects.toMatchObject({
    code: "PROXY_CONFIG",
    message: expect.stringContaining("no longer has a proxy section"),
  });
});

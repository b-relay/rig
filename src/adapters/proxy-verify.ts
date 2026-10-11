import { checkServerIdentity, connect } from "node:tls";
import {
  isStagingIssuer,
  judgeCertificate,
  type CertificateVerdict,
} from "../domain/certificate-check";
import { certificateName } from "../domain/managed-proxy";
import {
  currentGeneration,
  type PublishedGeneration,
} from "./proxy-generation";
import { routeFileHostnames } from "../providers/route-file";

/** Every hostname with a certificate that `generation` serves: Rig's sites and the owner's own routes. Read from the
 * generation itself, so it needs no rigd and names exactly what Caddy was given. */
function servedHostnames(
  generation: PublishedGeneration | undefined,
): string[] {
  const names = [
    ...routeFileHostnames(generation?.routes ?? ""),
    ...(generation?.customRoutes ?? []).map((route) => route.hostname),
  ]
    .map(certificateName)
    .filter((name): name is string => name !== undefined);
  return [...new Set(names)].sort();
}
/** One handshake with `hostname` on the local HTTPS port, trusting the runtime's root store (Mozilla's) plus `trust`, for tests. */
function handshake(
  hostname: string,
  port: number,
  now: Date,
  stagingOk: boolean,
  trust: readonly string[] | undefined,
): Promise<CertificateVerdict> {
  return new Promise((resolve) => {
    // Trust is judged here rather than by the handshake, so a staging certificate, which chains to no trusted root, can still
    // be told apart from one that is simply untrusted.
    const socket = connect({
      host: "127.0.0.1",
      port,
      servername: hostname,
      ...(trust ? { ca: [...trust] } : {}),
      rejectUnauthorized: false,
      timeout: 5000,
    });
    const fail = (problem: string) => {
      socket.destroy();
      resolve({ hostname, ok: false, problem });
    };
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      const issuer = { O: certificate.issuer?.O, CN: certificate.issuer?.CN };
      if (!socket.authorized) {
        // Only an explicitly accepted staging certificate for this very name passes without a trusted chain.
        const staging =
          stagingOk &&
          isStagingIssuer(issuer) &&
          checkServerIdentity(hostname, certificate) === undefined;
        if (!staging)
          return fail(
            `its certificate is not trusted (${String(socket.authorizationError ?? "unverified")})`,
          );
      }
      socket.end();
      resolve(
        judgeCertificate(
          hostname,
          {
            issuer,
            validTo: new Date(certificate.valid_to),
          },
          now,
          stagingOk,
        ),
      );
    });
    socket.once("timeout", () => fail("the TLS handshake timed out"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      fail(
        /ECONNREFUSED/.test(error.code ?? "")
          ? `nothing listens on 127.0.0.1:${port}`
          : /CERT|SIGNATURE|ISSUER|SELF_SIGNED/i.test(error.code ?? "")
            ? `its certificate is not trusted (${error.code})`
            : `the TLS handshake failed (${error.code ?? error.message})`,
      ),
    );
  });
}
/** Checks every served hostname with a real TLS handshake on the local HTTPS port, retrying the ones that fail until every
 * one passes or `waitMs` runs out. It reports what was served, never what Caddy's log suggests. */
export async function verifyProxyCertificates(options: {
  readonly root: string;
  /** The HTTPS port to dial, when the caller names one; otherwise the one the pinned generation was accepted with. */
  readonly port?: number;
  /** The port for a generation that recorded no settings: Host config's. */
  readonly defaultPort?: number;
  readonly stagingOk: boolean;
  readonly waitMs: number;
  readonly now?: () => Date;
  readonly trust?: readonly string[];
  readonly pause?: (ms: number) => Promise<void>;
}): Promise<CertificateVerdict[]> {
  const now = options.now ?? (() => new Date());
  const pause =
    options.pause ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + options.waitMs;
  const verdicts = new Map<string, CertificateVerdict>();
  for (;;) {
    // Hostnames and port from one generation, resolved once per pass: never a port from Host config Caddy has not taken.
    const generation = await currentGeneration(options.root);
    const port =
      options.port ??
      generation?.proxy?.ports.https ??
      options.defaultPort ??
      443;
    const names = servedHostnames(generation);
    const pending = names.filter((name) => !verdicts.get(name)?.ok);
    for (const verdict of await Promise.all(
      pending.map((name) =>
        handshake(name, port, now(), options.stagingOk, options.trust),
      ),
    ))
      verdicts.set(verdict.hostname, verdict);
    const result = names.map((name) => verdicts.get(name)!);
    if (result.every((verdict) => verdict.ok) || Date.now() >= deadline)
      return result;
    await pause(2000);
  }
}

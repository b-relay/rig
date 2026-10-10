/** What a TLS handshake with one hostname showed, reduced to what readiness depends on. */
export interface ServedCertificate {
  /** The issuer's organization and common name, as the certificate states them. */
  readonly issuer: { readonly O?: string; readonly CN?: string };
  /** When the certificate expires. */
  readonly validTo: Date;
}
/** Whether one served hostname is ready for public traffic, and why not. */
export interface CertificateVerdict {
  readonly hostname: string;
  readonly ok: boolean;
  readonly issuer?: string;
  readonly validTo?: string;
  /** Why the hostname is not ready; absent when it is. */
  readonly problem?: string;
}
/** Days of validity a served certificate must have left to count as ready. */
export const MINIMUM_DAYS_LEFT = 7;
/** Let's Encrypt's staging CA names itself "(STAGING)" in its issuers; other test CAs say "Fake" or "Staging". */
export function isStagingIssuer(issuer: ServedCertificate["issuer"]): boolean {
  return /staging|fake/i.test(`${issuer.O ?? ""} ${issuer.CN ?? ""}`);
}
/** Judges a certificate the system already trusted in the handshake: it must have at least seven days left and, unless
 * staging is allowed, come from a CA other than a staging one. Pure. */
export function judgeCertificate(
  hostname: string,
  certificate: ServedCertificate,
  now: Date,
  stagingOk: boolean,
): CertificateVerdict {
  const issuer =
    [certificate.issuer.O, certificate.issuer.CN].filter(Boolean).join(" / ") ||
    "unknown issuer";
  const base = {
    hostname,
    issuer,
    validTo: certificate.validTo.toISOString(),
  };
  const daysLeft = (certificate.validTo.getTime() - now.getTime()) / 86_400_000;
  if (daysLeft < MINIMUM_DAYS_LEFT)
    return {
      ...base,
      ok: false,
      problem:
        daysLeft <= 0
          ? "its certificate has expired"
          : `its certificate expires in ${Math.max(0, Math.floor(daysLeft))} days`,
    };
  if (!stagingOk && isStagingIssuer(certificate.issuer))
    return {
      ...base,
      ok: false,
      problem: "its certificate comes from a staging CA",
    };
  return { ...base, ok: true };
}

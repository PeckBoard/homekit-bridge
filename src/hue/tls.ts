// TLS to a Hue Bridge: the certificate must chain to a Signify Hue root CA and
// carry the lower-case bridge id as CN. Older firmware serves a self-signed
// cert instead; that one is pinned (SHA-256) when linking and must never
// change afterwards. Verification finishes BEFORE any byte (and so the
// application key) is sent.
import { connect, type PeerCertificate, type TLSSocket } from "node:tls";
import { ApiError } from "../errors.js";

/** Signify's Hue Bridge root CAs, as published under "Using HTTPS" in the
 * Hue developer docs
 * (https://developers.meethue.com/develop/application-design-guidance/using-https/,
 * behind a free developer login). Copied verbatim from that page via
 * homebridge-hue's hb-hue-tools (lib/HueClient.js, `rootCertificates`), which
 * cites the same page:
 *  - "C=NL, O=Philips Hue, CN=root-bridge" — square (gen-2) bridges;
 *  - "C=NL, O=Signify Hue, CN=Hue Root CA 01" — Bridge Pro (BSB003) and
 *    gen-2 bridges on 2025+ firmware. */
export const HUE_ROOT_CAS: readonly string[] = [
  `-----BEGIN CERTIFICATE-----
MIICMjCCAdigAwIBAgIUO7FSLbaxikuXAljzVaurLXWmFw4wCgYIKoZIzj0EAwIw
OTELMAkGA1UEBhMCTkwxFDASBgNVBAoMC1BoaWxpcHMgSHVlMRQwEgYDVQQDDAty
b290LWJyaWRnZTAiGA8yMDE3MDEwMTAwMDAwMFoYDzIwMzgwMTE5MDMxNDA3WjA5
MQswCQYDVQQGEwJOTDEUMBIGA1UECgwLUGhpbGlwcyBIdWUxFDASBgNVBAMMC3Jv
b3QtYnJpZGdlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEjNw2tx2AplOf9x86
aTdvEcL1FU65QDxziKvBpW9XXSIcibAeQiKxegpq8Exbr9v6LBnYbna2VcaK0G22
jOKkTqOBuTCBtjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAdBgNV
HQ4EFgQUZ2ONTFrDT6o8ItRnKfqWKnHFGmQwdAYDVR0jBG0wa4AUZ2ONTFrDT6o8
ItRnKfqWKnHFGmShPaQ7MDkxCzAJBgNVBAYTAk5MMRQwEgYDVQQKDAtQaGlsaXBz
IEh1ZTEUMBIGA1UEAwwLcm9vdC1icmlkZ2WCFDuxUi22sYpLlwJY81Wrqy11phcO
MAoGCCqGSM49BAMCA0gAMEUCIEBYYEOsa07TH7E5MJnGw557lVkORgit2Rm1h3B2
sFgDAiEA1Fj/C3AN5psFMjo0//mrQebo0eKd3aWRx+pQY08mk48=
-----END CERTIFICATE-----`,
  `-----BEGIN CERTIFICATE-----
MIIBzDCCAXOgAwIBAgICEAAwCgYIKoZIzj0EAwIwPDELMAkGA1UEBhMCTkwxFDAS
BgNVBAoMC1NpZ25pZnkgSHVlMRcwFQYDVQQDDA5IdWUgUm9vdCBDQSAwMTAgFw0y
NTAyMjUwMDAwMDBaGA8yMDUwMTIzMTIzNTk1OVowPDELMAkGA1UEBhMCTkwxFDAS
BgNVBAoMC1NpZ25pZnkgSHVlMRcwFQYDVQQDDA5IdWUgUm9vdCBDQSAwMTBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABFfOO0jfSAUXGQ9kjEDzyBrcMQ3ItyA5krE+
cyvb1Y3xFti7KlAad8UOnAx0FBLn7HZrlmIwm1QnX0fK3LPM13mjYzBhMB0GA1Ud
DgQWBBTF1pSpsCASX/z0VHLigxU2CAaqoTAfBgNVHSMEGDAWgBTF1pSpsCASX/z0
VHLigxU2CAaqoTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAKBggq
hkjOPQQDAgNHADBEAiAk7duT+IHbOGO4UUuGLAEpyYejGZK9Z7V9oSfnvuQ5BQIg
IYSgwwxHXm73/JgcU9lAM6c8Bmu3UE3kBIUwBs1qXFw=
-----END CERTIFICATE-----`,
];

export interface TrustTarget {
  bridgeId: string;
  host: string;
  port: number;
  /** Pinned SHA-256 (hex) of a self-signed bridge cert, if any. */
  pin: string | null;
  /** Linking: a self-signed cert with the right CN may be pinned now. */
  tofu?: boolean;
  /** Trust roots (tests); defaults to HUE_ROOT_CAS. */
  roots?: readonly string[];
}

export interface Trusted {
  /** "ca": chains to a root; "pin": the pinned / newly pinned self-signed cert. */
  trust: "ca" | "pin";
  fingerprint: string;
}

const SELF_SIGNED = new Set(["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"]);

function commonName(cert: PeerCertificate): string {
  const cn = cert.subject?.CN as string | string[] | undefined;
  return (Array.isArray(cn) ? cn[0] : (cn ?? "")).toLowerCase();
}

/** The trust decision, separated from the socket so it can be unit-tested.
 * Throws `hue_cert_changed`. */
export function checkPeer(
  peer: { authorized: boolean; authorizationError?: string | Error | null; cert: PeerCertificate },
  t: Pick<TrustTarget, "bridgeId" | "pin" | "tofu">,
): Trusted {
  const fingerprint = (peer.cert.fingerprint256 ?? "").replace(/:/g, "").toLowerCase();
  const cn = commonName(peer.cert);
  const want = t.bridgeId.toLowerCase();
  if (cn !== want) {
    throw new ApiError(
      "hue_cert_changed",
      `the bridge at this address presents a certificate for "${cn}", not ${want}`,
    );
  }
  if (peer.authorized) return { trust: "ca", fingerprint };
  if (t.pin) {
    if (fingerprint === t.pin) return { trust: "pin", fingerprint };
    throw new ApiError(
      "hue_cert_changed",
      `bridge ${want}: its certificate changed since it was linked (pinned sha256 ${t.pin}, now ${fingerprint}); unlink and link again if this is expected`,
    );
  }
  const why = String(peer.authorizationError ?? "unknown");
  if (t.tofu && SELF_SIGNED.has(why)) return { trust: "pin", fingerprint };
  throw new ApiError("hue_cert_changed", `bridge ${want}: untrusted certificate (${why})`);
}

/** Opens a TLS connection and resolves only once the peer passed
 * checkPeer(). */
export function connectTrusted(t: TrustTarget, timeoutMs: number): Promise<{ socket: TLSSocket } & Trusted> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: t.host,
      port: t.port,
      ca: [...(t.roots ?? HUE_ROOT_CAS)],
      // Decided below: chain (socket.authorized) + CN / pin by checkPeer().
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ApiError("hue_unreachable", `bridge ${t.bridgeId} at ${t.host}:${t.port}: TLS connect timed out`));
    }, timeoutMs);
    socket.once("error", (e) => {
      clearTimeout(timer);
      reject(new ApiError("hue_unreachable", `bridge ${t.bridgeId} at ${t.host}:${t.port}: ${e.message}`));
    });
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      try {
        const ok = checkPeer(
          { authorized: socket.authorized, authorizationError: socket.authorizationError, cert: socket.getPeerCertificate() },
          t,
        );
        socket.removeAllListeners("error");
        resolve({ socket, ...ok });
      } catch (e) {
        socket.destroy();
        reject(e);
      }
    });
  });
}

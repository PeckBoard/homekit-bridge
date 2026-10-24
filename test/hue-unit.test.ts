import { X509Certificate } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer, type PeerCertificate } from "node:tls";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { GAMUTS, clampToGamut, hsToXy, xyToHs } from "../src/hue/color.js";
import { parseAddress } from "../src/hue/client.js";
import { HUE_ROOT_CAS, checkPeer, connectTrusted } from "../src/hue/tls.js";

// Test-only CA and a leaf it signed (CN = ecb5fafffe0a1b2c).
const TEST_CA = `-----BEGIN CERTIFICATE-----
MIIB3jCCAYOgAwIBAgIUC16Gy6gu2ftdpyfirYzJuS+zPtgwCgYIKoZIzj0EAwIw
OzELMAkGA1UEBhMCTkwxETAPBgNVBAoMCFRlc3QgSHVlMRkwFwYDVQQDDBB0ZXN0
LXJvb3QtYnJpZGdlMCAXDTI2MTAyNDA1MTg1NloYDzIxMjYwOTMwMDUxODU2WjA7
MQswCQYDVQQGEwJOTDERMA8GA1UECgwIVGVzdCBIdWUxGTAXBgNVBAMMEHRlc3Qt
cm9vdC1icmlkZ2UwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAR7kGKT65ToRgQv
XbLRSOKOscb7dQoBw+c7t0nnaJ+bELuWIyDZBwAhGPQUIRO9vfhb1kVzZup1vff3
qJPcNvV9o2MwYTAdBgNVHQ4EFgQUr94q1r6EJjtlqSBTm9mx+NUnaVMwHwYDVR0j
BBgwFoAUr94q1r6EJjtlqSBTm9mx+NUnaVMwDwYDVR0TAQH/BAUwAwEB/zAOBgNV
HQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwIDSQAwRgIhAJxLmEie7DLF+LgD/ctNsWYl
/Wh1lanH9MdWVuzhom/5AiEArgJ8smKcvYNFfbsZKbJpxRSdJVokaM8hlYIh8X+P
LI4=
-----END CERTIFICATE-----`;
const LEAF_CERT = `-----BEGIN CERTIFICATE-----
MIIBvTCCAWKgAwIBAgIUb4N2hl4P5Ir/PTd2Y7eBOMPBkS4wCgYIKoZIzj0EAwIw
OzELMAkGA1UEBhMCTkwxETAPBgNVBAoMCFRlc3QgSHVlMRkwFwYDVQQDDBB0ZXN0
LXJvb3QtYnJpZGdlMCAXDTI2MTAyNDA1MTg1NloYDzIxMjYwOTMwMDUxODU2WjA7
MQswCQYDVQQGEwJOTDERMA8GA1UECgwIVGVzdCBIdWUxGTAXBgNVBAMMEGVjYjVm
YWZmZmUwYTFiMmMwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQ6IHYxtrJ1opsf
Z6yp3orIYPandfoTX+6M7blRLSy4l42tOyuOMqZKjw8LRbkKP81E0KUSGlf9rNXZ
vFN+ZUboo0IwQDAdBgNVHQ4EFgQUnaW/HkFo2SawTnu6siVpPj4RI5gwHwYDVR0j
BBgwFoAUr94q1r6EJjtlqSBTm9mx+NUnaVMwCgYIKoZIzj0EAwIDSQAwRgIhAIQt
RziVkSzsHAjy1ZX6Wu+mVQ0Eg2B57G1bBc0KH2UvAiEAwRdwSr0rlTumCFJtYltE
/C/Eeccn9xoKwO+AyeHy2so=
-----END CERTIFICATE-----`;
const LEAF_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgwptSx1SuV2dLADxF
HObVkvpb8lQN70QixWMlnoq1LeWhRANCAAQ6IHYxtrJ1opsfZ6yp3orIYPandfoT
X+6M7blRLSy4l42tOyuOMqZKjw8LRbkKP81E0KUSGlf9rNXZvFN+ZUbo
-----END PRIVATE KEY-----`;
const BRIDGE = "ecb5fafffe0a1b2c";

const code = async (f: () => unknown) => {
  try {
    await f();
  } catch (e) {
    return (e as ApiError).code;
  }
  return "ok";
};

describe("hue/sat <-> xy", () => {
  it("round-trips colours inside the gamut", () => {
    for (const [h, s] of [
      [30, 50],
      [200, 40],
      [300, 70],
      [0, 0],
    ]) {
      const back = xyToHs(hsToXy(h, s, GAMUTS.C));
      expect(back.sat).toBeCloseTo(s, 0);
      if (s > 0) expect(Math.abs(((back.hue - h + 540) % 360) - 180)).toBeLessThan(1.5);
    }
  });

  it("clamps out-of-gamut colours onto the light's gamut edge", () => {
    const green = hsToXy(120, 100, null);
    expect(green.y).toBeGreaterThan(0.7); // outside gamut C
    const clamped = hsToXy(120, 100, GAMUTS.C);
    expect(clamped).not.toEqual(green);
    expect(clampToGamut(clamped, GAMUTS.C)).toEqual(clamped); // now inside (or on the edge)
    expect(clamped.y).toBeLessThanOrEqual(0.7);
    // Points already inside are untouched.
    expect(clampToGamut({ x: 0.35, y: 0.35 }, GAMUTS.A)).toEqual({ x: 0.35, y: 0.35 });
  });
});

describe("Hue bridge TLS trust", () => {
  it("embeds the two Signify root CAs intact", () => {
    const subjects = HUE_ROOT_CAS.map((pem) => {
      const c = new X509Certificate(pem);
      expect(c.ca).toBe(true);
      expect(c.verify(c.publicKey)).toBe(true); // self-signed, transcription intact
      return c.subject.split("\n").find((l) => l.startsWith("CN="));
    });
    expect(subjects).toEqual(["CN=root-bridge", "CN=Hue Root CA 01"]);
  });

  const peer = (cn: string, fp = "AA:BB") => ({ subject: { CN: cn }, fingerprint256: fp }) as unknown as PeerCertificate;

  it("decides CA / pin / TOFU / refuse", async () => {
    const t = { bridgeId: BRIDGE, pin: null };
    expect(checkPeer({ authorized: true, cert: peer(BRIDGE) }, t).trust).toBe("ca");
    expect(await code(() => checkPeer({ authorized: true, cert: peer("001788fffe000000") }, t))).toBe("hue_cert_changed");
    const selfSigned = { authorized: false, authorizationError: "DEPTH_ZERO_SELF_SIGNED_CERT", cert: peer(BRIDGE) };
    expect(await code(() => checkPeer(selfSigned, t))).toBe("hue_cert_changed");
    expect(checkPeer(selfSigned, { ...t, tofu: true })).toEqual({ trust: "pin", fingerprint: "aabb" });
    expect(checkPeer(selfSigned, { ...t, pin: "aabb" }).trust).toBe("pin");
    expect(await code(() => checkPeer(selfSigned, { ...t, pin: "ccdd" }))).toBe("hue_cert_changed");
    const unknownCa = { authorized: false, authorizationError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", cert: peer(BRIDGE) };
    expect(await code(() => checkPeer(unknownCa, { ...t, tofu: true }))).toBe("hue_cert_changed");
  });

  it("verifies a real TLS chain against the given roots and the bridge-id CN", async () => {
    const server = createServer({ cert: LEAF_CERT, key: LEAF_KEY }, (s) => s.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const target = { bridgeId: BRIDGE, host: "127.0.0.1", port, pin: null };
      const ok = await connectTrusted({ ...target, roots: [TEST_CA] }, 5000);
      ok.socket.destroy();
      expect(ok.trust).toBe("ca");
      // Signed by a CA we don't trust: refused even when linking.
      expect(await code(() => connectTrusted({ ...target, tofu: true }, 5000))).toBe("hue_cert_changed");
      expect(await code(() => connectTrusted({ ...target, bridgeId: "001788fffe000000", roots: [TEST_CA] }, 5000))).toBe(
        "hue_cert_changed",
      );
    } finally {
      server.close();
    }
  });

  it("parses bridge addresses", () => {
    expect(parseAddress("192.168.1.30")).toEqual({ host: "192.168.1.30", port: 443 });
    expect(parseAddress("127.0.0.1:8443")).toEqual({ host: "127.0.0.1", port: 8443 });
    expect(parseAddress("[fe80::1]:444")).toEqual({ host: "fe80::1", port: 444 });
    expect(parseAddress("fe80::1")).toEqual({ host: "fe80::1", port: 443 });
  });
});

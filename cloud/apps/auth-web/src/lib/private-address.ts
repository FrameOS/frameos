import { isIP } from "node:net";

// Which addresses a server-side fetch must not reach; ssrf.ts builds its guard
// on this. It is a module of its own because the frame hub needs the
// classifier for its renderer (scene-render.ts) and must not load ssrf.ts:
// that imports npm undici, which takes over the hub's global fetch
// (frame-hub/src/hub-bundle.test.ts). Keep undici out of this file.

// The classifier's source, kept as plain JavaScript on purpose: the headless
// renderer (scene-render.ts) runs its HTTP bridge in a child Node started
// with `-e` and cannot import this module, so it splices this string into
// that script. One source, two guards that cannot drift — the renderer's
// used to be a hand-copied subset missing 192.0.0.0/24, 198.18/15, NAT64 and
// 6to4. `isIP` is the only dependency and is passed in.
export const addressIsPrivateSource = String.raw`
function addressIsPrivate(address) {
  const plain = address.split("%")[0] || address;
  if (isIP(plain) === 4) {
    const octets = plain.split(".").map(Number);
    const a = octets[0] === undefined ? -1 : octets[0];
    const b = octets[1] === undefined ? -1 : octets[1];
    const c = octets[2] === undefined ? -1 : octets[2];
    return (
      a === 0 || // unspecified
      a === 10 ||
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) || // IETF protocol assignments (192.0.0.0/24)
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) || // benchmarking (198.18.0.0/15)
      a >= 224 // multicast + reserved
    );
  }
  const lower = plain.toLowerCase();
  // Loopback, unspecified, link-local, unique-local, and the forms that embed
  // a v4 address (v4-mapped, NAT64 64:ff9b::/96, 6to4 2002::/16): those carry
  // the v4 target in their low bits, so an internal address would otherwise
  // slip in dressed as a public-looking v6 literal. All of them are refused
  // outright rather than decoded — nothing this guard fronts needs them.
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("::ffff:") ||
    lower.startsWith("64:ff9b:") ||
    lower.startsWith("2002:")
  );
}
`;

export const addressIsPrivate = new Function(
  "isIP",
  `${addressIsPrivateSource}\nreturn addressIsPrivate;`,
)(isIP) as (address: string) => boolean;

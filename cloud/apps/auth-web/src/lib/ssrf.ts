import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// SSRF guard shared by every server-side fetch of a user-supplied URL (the
// preview proxy, the MCP server's scene imports): reject hosts resolving to
// loopback / private / link-local / reserved addresses so the server cannot
// be used to probe its own network. DNS resolves once here; a rebind between
// check and fetch is a residual risk accepted for these features.
export async function hostIsBlocked(hostname: string): Promise<boolean> {
  const literal = isIP(hostname) ? [hostname] : null;
  let addresses: string[];
  if (literal) {
    addresses = literal;
  } else {
    try {
      const results = await lookup(hostname, { all: true, verbatim: true });
      addresses = results.map((result) => result.address);
    } catch {
      return true;
    }
  }
  return addresses.length === 0 || addresses.some(addressIsPrivate);
}

export function addressIsPrivate(address: string): boolean {
  const plain = address.split("%")[0] ?? address;
  if (isIP(plain) === 4) {
    const octets = plain.split(".").map(Number);
    const [a = -1, b = -1, c = -1] = octets;
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

// A fetch that applies the guard before every request (redirects included:
// each hop is checked, so a public URL cannot bounce to an internal one).
export async function guardedFetch(
  input: string,
  init?: RequestInit,
  maxRedirects = 5,
): Promise<Response> {
  let url = new URL(input);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("invalid_url");
    }
    if (await hostIsBlocked(url.hostname)) {
      throw new Error("host_not_allowed");
    }
    const response = await fetch(url, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    return response;
  }
  throw new Error("too_many_redirects");
}

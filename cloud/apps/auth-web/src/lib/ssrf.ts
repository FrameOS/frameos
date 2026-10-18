import dns from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

// SSRF guard shared by every server-side fetch of a user-supplied URL (the
// preview proxy, the MCP server's scene imports): reject hosts resolving to
// loopback / private / link-local / reserved addresses so the server cannot
// be used to probe its own network. hostIsBlocked answers early with a clear
// refusal; the check that holds is the connect's own (guardedLookup below),
// because a name checked here and resolved again by fetch can answer the
// second query with a private address (DNS rebinding).
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

// Headers that name the caller to ONE host. A redirect that leaves the
// origin the caller addressed must not carry them along — the same rule
// the runtime's own HTTP client (frameos/src/frameos/utils/http_client.nim)
// applies — or an app's API key for host A is handed to whatever host A
// bounces to.
const credentialHeaders = ["authorization", "cookie", "proxy-authorization"];

function withoutCredentialHeaders(headers: HeadersInit | undefined): Headers {
  const stripped = new Headers(headers);
  for (const name of credentialHeaders) {
    stripped.delete(name);
  }
  return stripped;
}

class HostNotAllowedError extends Error {
  constructor() {
    super("host_not_allowed");
  }
}

// The lookup every guarded connect makes (net/tls `lookup`): the addresses it
// hands the socket are the ones it classified, so there is no second answer
// to rebind. A literal host never reaches it (net connects to a literal as
// is), which is what hostIsBlocked's own check is for.
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error, "");
      return;
    }
    const list = addresses as dns.LookupAddress[];
    const first = list[0];
    if (!first || list.some((entry) => addressIsPrivate(entry.address))) {
      callback(new HostNotAllowedError(), "");
      return;
    }
    if (options.all) {
      callback(null, list);
    } else {
      callback(null, first.address, first.family);
    }
  });
};

const guardedDispatcher = new Agent({ connect: { lookup: guardedLookup } });

function refusedByGuard(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof HostNotAllowedError) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// undici's own fetch with the guarded dispatcher (not the global fetch: its
// bundled undici and this one are not guaranteed to share a dispatcher
// interface).
export async function pinnedFetch(input: URL | string, init?: RequestInit): Promise<Response> {
  try {
    const response = await undiciFetch(input, {
      ...(init as UndiciRequestInit),
      dispatcher: guardedDispatcher,
    });
    return response as unknown as Response;
  } catch (error) {
    if (refusedByGuard(error)) {
      throw new Error("host_not_allowed");
    }
    throw error;
  }
}

// A fetch that applies the guard before every request (redirects included:
// each hop is checked, so a public URL cannot bounce to an internal one, and
// credential headers stay behind when a hop changes origin), and again where
// it counts, at connect time (pinnedFetch). `fetchImpl` is for tests.
export async function guardedFetch(
  input: string,
  init?: RequestInit,
  maxRedirects = 5,
  fetchImpl: (input: URL | string, init?: RequestInit) => Promise<Response> = pinnedFetch,
): Promise<Response> {
  let url = new URL(input);
  let headers: HeadersInit | undefined = init?.headers;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("invalid_url");
    }
    if (await hostIsBlocked(url.hostname)) {
      throw new Error("host_not_allowed");
    }
    const response = await fetchImpl(url, {
      ...init,
      ...(headers === undefined ? {} : { headers }),
      redirect: "manual",
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        headers = withoutCredentialHeaders(headers);
      }
      url = next;
      continue;
    }
    return response;
  }
  throw new Error("too_many_redirects");
}

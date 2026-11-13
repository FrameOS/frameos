import dns from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import { addressIsPrivate } from "./private-address";

export { addressIsPrivate, addressIsPrivateSource } from "./private-address";

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

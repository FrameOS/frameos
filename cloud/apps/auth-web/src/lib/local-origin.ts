// Where a local FrameOS install (a backend or a frame's admin panel) says a
// browser reaches it. Kept free of next/* so the frame hub can bundle it:
// the hub fills a linked client's missing local_origin from the device's
// hello (see hub.ts), the same field device/start and frames/enroll record.

// Hosts a self-hosted FrameOS install can plausibly live on: this machine, a
// private network, or an mDNS name. Anything else is somewhere on the public
// internet, which a local install is not.
export function isLocalHostname(hostname: string) {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }
  // IPv6 literals only: loopback, link-local and unique-local. The prefix
  // tests must never run against a DNS name — "fdcloud.example.com" starts
  // with "fd" too, and this allowlist decides where login codes may be sent.
  if (host.includes(":")) {
    return (
      host === "::1" ||
      host.startsWith("fe80:") ||
      /^f[cd][0-9a-f]{2}:/.test(host)
    );
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) {
    return false;
  }
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((part) => part > 255)) {
    return false;
  }
  const [a = -1, b = -1] = octets;
  if (a === 127 || a === 10) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  return false;
}

// The backend's reported local address. device/start is unauthenticated, so
// this is entirely attacker-supplied, and it is not merely decoration: it is
// shown to the approving user as "Request from", it is the allowlist for the
// login handoff's redirect_uri, and the approval screen will navigate the
// browser back to it. Despite the name it used to accept any public origin,
// so a request claiming to come from "https://frameos.example.com" looked as
// legitimate on the consent screen as a real one — and then received login
// codes. Restricted to addresses a local install can actually have.
export function safeLocalOrigin(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    if (url.username || url.password) {
      return undefined;
    }
    if (!isLocalHostname(url.hostname)) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

// Where this process answers HTTP, for in-process callers of its own routes
// (the MCP server's tools, the AI chat's MCP tools). NOT
// `new URL(request.url).origin`: behind nginx Next reports that as
// `https://localhost:3000` (see getPublicOrigin in src/lib/env.ts), and a TLS
// handshake against the plain-HTTP Node port fails every tool call with
// "fetch failed". The systemd unit starts the server with PORT=<instance> and
// HOSTNAME=127.0.0.1, so plain http on the loopback address and that port is
// the address that actually works; FRAMEOS_MCP_INTERNAL_ORIGIN overrides it.
export function internalOrigin(): string {
  const configured = process.env.FRAMEOS_MCP_INTERNAL_ORIGIN?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  const port = process.env.PORT?.trim() || "3000";
  return `http://127.0.0.1:${port}`;
}

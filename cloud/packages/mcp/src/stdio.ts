import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFrameosMcpServer, posthog } from "./server";

// Local (stdio) entry point, for MCP clients that cannot speak Streamable
// HTTP or that prefer a subprocess:
//
//   FRAMEOS_CLOUD_TOKEN=fc_api_… pnpm --filter @frameos-cloud/mcp start
//
// FRAMEOS_CLOUD_URL overrides the API origin (default https://cloud.frameos.net);
// FRAMEOS_STORE_URL the store origin used in links (default https://scenes.frameos.net).
// The hosted endpoint at ${FRAMEOS_CLOUD_URL}/api/mcp needs no local process.

const token = process.env.FRAMEOS_CLOUD_TOKEN?.trim();
if (!token) {
  process.stderr.write(
    "frameos-cloud-mcp: set FRAMEOS_CLOUD_TOKEN to a personal API token (create one at /account/developer)\n",
  );
  process.exit(2);
}

const baseUrl = (process.env.FRAMEOS_CLOUD_URL?.trim() || "https://cloud.frameos.net").replace(/\/+$/, "");
const storeOrigin = process.env.FRAMEOS_STORE_URL?.trim() || undefined;

const server = createFrameosMcpServer({
  baseUrl,
  publicOrigin: baseUrl,
  storeOrigin: storeOrigin ?? (baseUrl.includes("cloud.frameos.net") ? "https://scenes.frameos.net" : baseUrl),
  token,
});

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGTERM", async () => {
  await posthog.shutdown();
  process.exit(0);
});

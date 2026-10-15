import { useValues } from 'kea'

import { Box } from '../../../components/Box'
import { Code } from '../../../components/Code'
import { ApiTokensCard } from '../ApiTokens'
import { apiTokensLogic } from '../apiTokensLogic'
import { AccountPageHeader, AccountSection } from './AccountPageHeader'

// The MCP server, as the cloud documents it: hosted, Streamable HTTP, a
// personal API token as the bearer. The endpoint comes with the token
// listing (GET /api/account/api-tokens mcp_url), so a deployment on another
// origin names its own.
function McpServerCard(): JSX.Element {
  const { listing } = useValues(apiTokensLogic)
  const mcpUrl = listing.mcp_url || '…'
  const cloudUrl = mcpUrl.replace(/\/api\/mcp$/, '')
  return (
    <Box className="space-y-4 p-4 text-sm">
      <div className="space-y-1">
        <div className="frameos-muted text-xs">Endpoint</div>
        <Code className="block break-all select-all" data-testid="mcp-url">
          {mcpUrl}
        </Code>
      </div>
      <div className="space-y-1">
        <div className="frameos-strong font-semibold">Claude Code</div>
        <Code className="block whitespace-pre-wrap break-all">{`claude mcp add --transport http frameos ${mcpUrl} \\
  --header "Authorization: Bearer fc_api_…"`}</Code>
      </div>
      <div className="space-y-1">
        <div className="frameos-strong font-semibold">Codex</div>
        <Code className="block whitespace-pre-wrap break-all">{`FRAMEOS_CLOUD_TOKEN=fc_api_… codex mcp add frameos --url ${mcpUrl} \\
  --bearer-token-env-var FRAMEOS_CLOUD_TOKEN`}</Code>
        <p className="frameos-muted text-xs">
          Or in <code>~/.codex/config.toml</code>, with the token in the environment Codex starts from:
        </p>
        <Code className="block whitespace-pre-wrap break-all">{`[mcp_servers.frameos]
url = "${mcpUrl}"
bearer_token_env_var = "FRAMEOS_CLOUD_TOKEN"`}</Code>
      </div>
      <div className="space-y-1">
        <div className="frameos-strong font-semibold">Other clients</div>
        <Code className="block whitespace-pre-wrap break-all">
          {JSON.stringify(
            { mcpServers: { frameos: { headers: { Authorization: 'Bearer fc_api_…' }, type: 'http', url: mcpUrl } } },
            null,
            2
          )}
        </Code>
      </div>
      <div className="space-y-1">
        <div className="frameos-strong font-semibold">Run it locally instead (stdio)</div>
        <p className="frameos-muted text-xs">
          From a checkout of the FrameOS repository, the same server runs as a subprocess and talks to this API with
          your token:
        </p>
        <Code className="block whitespace-pre-wrap break-all">{`FRAMEOS_CLOUD_TOKEN=fc_api_… FRAMEOS_CLOUD_URL=${cloudUrl} \\
  pnpm --filter @frameos-cloud/mcp start`}</Code>
      </div>
      <div className="space-y-1">
        <div className="frameos-strong font-semibold">What it can do</div>
        <ul className="frameos-muted list-disc space-y-1 pl-5 text-sm leading-relaxed">
          <li>
            <strong>Frames</strong>: list and inspect, rename, save settings and schedules, assign and activate scenes,
            screenshots, logs, metrics, activity, asset files, reboot/restart, firmware updates, claim tokens for new
            frames.
          </li>
          <li>
            <strong>Scenes</strong>: list, read and save scene JSON as new versions, create from JSON/zip/URL, fork,
            rename, publish to the store, tags/category/description, gallery images, yank or restore versions, delete.
          </li>
          <li>
            <strong>Preview and check</strong>: render any scene on the server with the real FrameOS runtime and get the
            image back; lint scenes the way publishing does.
          </li>
          <li>
            <strong>Scene AI</strong>: ask the cloud's scene assistant to build or change a scene, then save or install
            the result.
          </li>
          <li>
            <strong>Store and account</strong>: browse the public store, account settings and service keys, usage
            against every quota.
          </li>
        </ul>
      </div>
    </Box>
  )
}

export function DeveloperPage(): JSX.Element {
  return (
    <div className="space-y-8">
      <AccountPageHeader page="developer" />
      <AccountSection
        title="API tokens"
        description="A personal API token stands in for your account on the JSON API and the MCP server: frames, scenes, the store and the scene AI, everything you can do here, except revoking frames and approving device links, which always need a fresh sign-in in the browser. Tokens are shown once and stored hashed."
      >
        <ApiTokensCard />
      </AccountSection>
      <AccountSection
        title="MCP server"
        description="Connect an AI agent such as Claude Code or Codex to your frames over the Model Context Protocol. The server is hosted here, with no local process to run, and speaks Streamable HTTP with your API token as a bearer."
      >
        <McpServerCard />
      </AccountSection>
    </div>
  )
}

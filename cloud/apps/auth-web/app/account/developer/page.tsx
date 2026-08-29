import { createDb } from "@frameos-cloud/db";
import {
  ApiTokensSection,
  type ApiTokenPayload,
} from "../../../src/components/ApiTokensSection";
import { CopyUrlField } from "../../../src/components/CopyUrlField";
import {
  listApiTokens,
  maxApiTokensPerAccount,
} from "../../../src/lib/api-tokens";
import { getAccountUrl, getCloudBaseUrl } from "../../../src/lib/env";
import {
  hasRecentAuth,
  reauthPath,
  recentApprovalMaxAgeSeconds,
} from "../../../src/lib/recent-auth";
import { readSession } from "../../../src/lib/session";

export const metadata = { title: "Developer" };

// API tokens and the MCP server, for people who drive their frames and
// scenes from scripts or an AI agent. Everything a token can do is what the
// signed-in account can do in the UI, minus the sudo-mode actions; the MCP
// endpoint is the same API with a vocabulary an agent can read.
export default async function AccountDeveloperPage() {
  const session = await readSession();
  const accountId = session?.accountId;

  let tokens: ApiTokenPayload[] = [];
  let canCreate = false;
  if (accountId) {
    const db = createDb();
    [tokens, canCreate] = await Promise.all([
      listApiTokens(db, accountId) as Promise<ApiTokenPayload[]>,
      hasRecentAuth(db, recentApprovalMaxAgeSeconds),
    ]);
  }

  const cloudUrl = getCloudBaseUrl().replace(/\/$/, "");
  const mcpUrl = `${cloudUrl}/api/mcp`;
  const reauthUrl = new URL(reauthPath, cloudUrl);
  reauthUrl.searchParams.set("return_to", getAccountUrl("/account/developer"));

  return (
    <>
      <section className="section-block">
        <div className="content-header compact-header">
          <div>
            <h2>API tokens</h2>
            <p className="copy">
              A personal API token stands in for your account on the JSON API
              and the MCP server: frames, scenes, the store and the scene AI,
              everything you can do here — except revoking frames and
              approving device links, which always need a fresh sign-in in the
              browser. Tokens are shown once and stored hashed.
            </p>
          </div>
        </div>
        <section className="card">
          <ApiTokensSection
            canCreate={canCreate}
            initialTokens={tokens}
            maxTokens={maxApiTokensPerAccount}
            reauthHref={reauthUrl.toString()}
          />
        </section>
      </section>

      <section className="section-block">
        <div className="content-header compact-header">
          <div>
            <h2>MCP server</h2>
            <p className="copy">
              Connect an AI agent (Claude Code, Claude Desktop, Cursor, or any
              Model Context Protocol client) to your frames. The server is
              hosted here — no local process — and speaks Streamable HTTP with
              your API token as a bearer.
            </p>
          </div>
        </div>
        <section className="card stack">
          <div className="field">
            <label htmlFor="mcp-url">Endpoint</label>
            <CopyUrlField value={mcpUrl} />
          </div>
          <h3>Claude Code</h3>
          <pre className="code-block">
            <code>{`claude mcp add --transport http frameos ${mcpUrl} \\
  --header "Authorization: Bearer fc_api_…"`}</code>
          </pre>
          <h3>Claude Desktop, Cursor and other clients</h3>
          <pre className="code-block">
            <code>{JSON.stringify(
              {
                mcpServers: {
                  frameos: {
                    headers: { Authorization: "Bearer fc_api_…" },
                    type: "http",
                    url: mcpUrl,
                  },
                },
              },
              null,
              2,
            )}</code>
          </pre>
          <h3>Run it locally instead (stdio)</h3>
          <p className="copy">
            From a checkout of the FrameOS repository, the same server runs as
            a subprocess and talks to this API with your token:
          </p>
          <pre className="code-block">
            <code>{`FRAMEOS_CLOUD_TOKEN=fc_api_… FRAMEOS_CLOUD_URL=${cloudUrl} \\
  pnpm --filter @frameos-cloud/mcp start`}</code>
          </pre>
          <h3>What it can do</h3>
          <ul className="copy">
            <li>
              <strong>Frames</strong> — list and inspect, rename, push settings
              and schedules, assign and activate scenes, screenshots, logs,
              metrics, activity, asset files, reboot/restart, firmware updates,
              claim tokens for new frames.
            </li>
            <li>
              <strong>Scenes</strong> — list, read and save scene JSON as new
              versions, create from JSON/zip/URL, fork, rename, publish to the
              store, tags/category/description, gallery images, yank or
              restore versions, delete.
            </li>
            <li>
              <strong>Preview and check</strong> — render any scene on the
              server with the real FrameOS runtime and get the image back;
              lint scenes the way publishing does.
            </li>
            <li>
              <strong>Scene AI</strong> — ask the cloud&apos;s scene assistant to
              build or change a scene, then save or install the result.
            </li>
            <li>
              <strong>Store and account</strong> — browse the public store,
              account settings and service keys, usage against every quota.
            </li>
          </ul>
        </section>
      </section>
    </>
  );
}

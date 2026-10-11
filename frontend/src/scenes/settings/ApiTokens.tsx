import { useActions, useValues } from 'kea'
import { Form } from 'kea-forms'
import { ClipboardDocumentIcon } from '@heroicons/react/24/solid'

import { Box } from '../../components/Box'
import { Button } from '../../components/Button'
import { Code } from '../../components/Code'
import { Field } from '../../components/Field'
import { H6 } from '../../components/H6'
import { NumberTextInput } from '../../components/NumberTextInput'
import { Select } from '../../components/Select'
import { Spinner } from '../../components/Spinner'
import { Tag } from '../../components/Tag'
import { TextInput } from '../../components/TextInput'
import { confirmDialog } from '../../utils/confirmDialogLogic'
import { apiTokensLogic, type ApiToken } from './apiTokensLogic'

function formatDay(value: string | null): string {
  if (!value) {
    return 'never'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

function tokenStateLabel(token: ApiToken): string {
  if (token.revoked_at) {
    return `revoked ${formatDay(token.revoked_at)}`
  }
  if (token.expires_at && new Date(token.expires_at).getTime() <= Date.now()) {
    return `expired ${formatDay(token.expires_at)}`
  }
  return `expires ${formatDay(token.expires_at)}`
}

function TokenRow({ token, live }: { token: ApiToken; live: boolean }): JSX.Element {
  const { revokingTokenId } = useValues(apiTokensLogic)
  const { revokeToken } = useActions(apiTokensLogic)
  return (
    <tr className={live ? '' : 'frameos-muted'}>
      <td className="py-1 pr-3 align-top">
        <div className="frameos-strong font-medium">{token.name}</div>
        <div className="frameos-muted font-mono text-xs">{token.hint}…</div>
      </td>
      <td className="py-1 pr-3 align-top">
        <Tag color={token.access === 'read_only' ? 'gray' : 'blue'}>
          {token.access === 'read_only' ? 'read only' : 'full'}
        </Tag>
      </td>
      <td className="py-1 pr-3 align-top text-xs">
        <div>{tokenStateLabel(token)}</div>
        <div className="frameos-muted">last used {formatDay(token.last_used_at)}</div>
      </td>
      <td className="py-1 align-top text-right">
        {live ? (
          <Button
            size="tiny"
            color="secondary"
            disabled={revokingTokenId === token.id}
            onClick={() => {
              void confirmDialog({
                title: 'Revoke this API token?',
                message: `Scripts and MCP clients using "${token.name}" stop working immediately. This cannot be undone.`,
                confirmLabel: 'Revoke',
                danger: true,
                onConfirm: () => {
                  revokeToken(token.id)
                },
              })
            }}
          >
            {revokingTokenId === token.id ? <Spinner /> : 'Revoke'}
          </Button>
        ) : null}
      </td>
    </tr>
  )
}

function CreatedTokenNotice(): JSX.Element | null {
  const { createdToken } = useValues(apiTokensLogic)
  const { copyCreatedToken, dismissCreatedToken } = useActions(apiTokensLogic)
  if (!createdToken) {
    return null
  }
  return (
    <div className="space-y-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3">
      <div className="text-sm">
        Token <span className="frameos-strong font-medium">{createdToken.api_token.name}</span> created. Copy it now: it
        is shown once and stored hashed.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Code className="break-all" data-testid="created-api-token">
          {createdToken.token}
        </Code>
        <Button size="tiny" color="primary" onClick={copyCreatedToken} className="inline-flex items-center gap-1">
          <ClipboardDocumentIcon className="h-3.5 w-3.5" />
          Copy
        </Button>
        <Button size="tiny" color="secondary" onClick={dismissCreatedToken}>
          Done
        </Button>
      </div>
    </div>
  )
}

function CreateTokenForm(): JSX.Element {
  const { createOpen, isNewTokenSubmitting, listing } = useValues(apiTokensLogic)
  const { setCreateOpen, resetNewToken } = useActions(apiTokensLogic)
  const atCap = listing.live_count >= listing.max_tokens
  if (!createOpen) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="small"
          color="primary"
          onClick={() => setCreateOpen(true)}
          disabled={!listing.can_create || atCap}
        >
          Create token
        </Button>
        {atCap ? (
          <span className="frameos-muted text-xs">
            {listing.max_tokens} live tokens is the limit. Revoke one to create another.
          </span>
        ) : null}
        {!listing.can_create ? (
          <span className="frameos-muted text-xs">Tokens are created from a browser session, not with a token.</span>
        ) : null}
      </div>
    )
  }
  return (
    <Form logic={apiTokensLogic} formKey="newToken" enableFormOnSubmit className="space-y-3">
      <div className="grid gap-3 @md:grid-cols-2">
        <Field name="name" label="Name">
          <TextInput placeholder="e.g. Claude Code on the laptop" autoFocus />
        </Field>
        <Field name="access" label="Access">
          <Select
            options={[
              { value: 'full', label: 'Full: everything this account can do' },
              { value: 'read_only', label: 'Read only: look, never change' },
            ]}
          />
        </Field>
        <Field name="expires_in_days" label={`Expires in days (1 to ${listing.max_ttl_days})`}>
          <NumberTextInput min={1} max={listing.max_ttl_days} />
        </Field>
        <Field name="current_password" label="Current password">
          <TextInput type="password" autoComplete="current-password" />
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          color="secondary"
          size="small"
          disabled={isNewTokenSubmitting}
          onClick={() => {
            resetNewToken()
            setCreateOpen(false)
          }}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          color="primary"
          size="small"
          disabled={isNewTokenSubmitting}
          className="inline-flex items-center gap-2"
        >
          {isNewTokenSubmitting ? <Spinner color="white" /> : null}
          Create token
        </Button>
      </div>
    </Form>
  )
}

// Tokens are local-account credentials: under Home Assistant ingress there
// is no local login to mint them behind, and the routes answer 401.
export function IngressApiTokensSection(): JSX.Element {
  return (
    <div className="space-y-4">
      <H6 id="settings-developer" className="pt-4">
        API tokens and MCP
      </H6>
      <Box className="settings-api-tokens-card p-4">
        <div className="frameos-muted text-sm">
          API tokens and the MCP server need a local FrameOS login, which Home Assistant ingress replaces. Run FrameOS
          outside ingress to use them.
        </div>
      </Box>
    </div>
  )
}

export function ApiTokensSection(): JSX.Element {
  const { listing, listingLoading, liveTokens, pastTokens, mcpCommand } = useValues(apiTokensLogic)
  return (
    <div className="space-y-4">
      <H6 id="settings-developer" className="pt-4">
        API tokens and MCP
      </H6>
      <Box className="settings-api-tokens-card space-y-4 p-4">
        <p className="text-sm leading-relaxed">
          A personal API token stands in for your account on the JSON API and the MCP server: frames, scenes, settings
          and the scene AI, everything you can do here. Tokens cannot create tokens or change your email or password.
          They are shown once and stored hashed.
        </p>
        {listingLoading && listing.api_tokens.length === 0 ? (
          <Spinner />
        ) : liveTokens.length === 0 && pastTokens.length === 0 ? (
          <div className="frameos-muted text-sm">No API tokens yet.</div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {liveTokens.map((token) => (
                <TokenRow key={token.id} token={token} live />
              ))}
              {pastTokens.map((token) => (
                <TokenRow key={token.id} token={token} live={false} />
              ))}
            </tbody>
          </table>
        )}
        <CreatedTokenNotice />
        <CreateTokenForm />
      </Box>
      <Box className="settings-mcp-card space-y-3 p-4">
        <div className="frameos-strong font-medium">MCP server</div>
        <p className="text-sm leading-relaxed">
          Connect an AI agent (Claude Code, Claude Desktop, Cursor, or any Model Context Protocol client) to this
          backend. The server runs here, speaks Streamable HTTP, and takes an API token as the bearer. Tools that change
          what a frame shows ask the agent to confirm the user asked for it.
        </p>
        <div className="space-y-1 text-sm">
          <div className="frameos-muted text-xs">Endpoint</div>
          <Code className="block break-all" data-testid="mcp-url">
            {listing.mcp_url || '…'}
          </Code>
        </div>
        <div className="space-y-1 text-sm">
          <div className="frameos-muted text-xs">Claude Code</div>
          <Code className="block break-all">{mcpCommand}</Code>
        </div>
        <p className="frameos-muted text-xs">
          Any other client: a Streamable HTTP server at the endpoint above with an Authorization: Bearer header. Details
          in docs/mcp.md.
        </p>
      </Box>
    </div>
  )
}

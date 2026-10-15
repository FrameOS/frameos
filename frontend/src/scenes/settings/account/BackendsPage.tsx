import { useActions, useValues } from 'kea'
import { ArrowTopRightOnSquareIcon, XMarkIcon } from '@heroicons/react/24/outline'

import { Box } from '../../../components/Box'
import { Button } from '../../../components/Button'
import { DropdownMenu } from '../../../components/DropdownMenu'
import { Spinner } from '../../../components/Spinner'
import { Tag } from '../../../components/Tag'
import { AccountPageHeader, AccountTable } from './AccountPageHeader'
import { backendsLogic, type LinkedBackend } from './backendsLogic'
import { formatDateTime } from './format'

// A linked backend opened inside the workspace: a full-viewport overlay with
// a bar saying what is shown and where it came from, and the backend in an
// iframe below. The backend is a separate app with its own login; this only
// frames it.
function BackendViewer({ backend }: { backend: LinkedBackend }): JSX.Element {
  const { closeBackend } = useActions(backendsLogic)
  const origin = backend.origin ?? ''
  return (
    <div role="dialog" aria-modal className="frameos-panel fixed inset-0 z-[100] flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-500/20 px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <span className="frameos-strong font-semibold">FrameOS backend: {backend.name}</span>
          <Tag title={origin}>{origin}</Tag>
          <span className="frameos-muted text-xs">viewed from FrameOS Cloud</span>
        </div>
        <div className="flex items-center gap-2">
          <a
            className="frameos-button frameos-secondary-button inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm"
            href={origin}
            rel="noreferrer noopener"
            target="_blank"
          >
            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            Open in new tab
          </a>
          <Button size="small" color="secondary" onClick={closeBackend} className="inline-flex items-center gap-1">
            <XMarkIcon className="h-4 w-4" />
            Close
          </Button>
        </div>
      </div>
      <iframe className="min-h-0 flex-1 border-0 bg-white" src={origin} title={`FrameOS backend at ${origin}`} />
    </div>
  )
}

export function BackendsPage(): JSX.Element {
  const { backends, backendsLoading, visibleBackends, revokedCount, showRevoked, revokingId, openBackend } =
    useValues(backendsLogic)
  const { setShowRevoked, revokeBackend, openBackendViewer } = useActions(backendsLogic)

  return (
    <div>
      <AccountPageHeader
        page="backends"
        actions={
          <>
            {revokedCount > 0 ? (
              <Button size="small" color="secondary" onClick={() => setShowRevoked(!showRevoked)}>
                {showRevoked ? 'Hide revoked' : `Show ${revokedCount} revoked`}
              </Button>
            ) : null}
            {/* The device-link page is a page of the cloud app, next to this SPA on the account origin. */}
            <a
              className="frameos-button frameos-primary-action rounded-md px-2 py-1 text-sm font-medium"
              href="/device"
            >
              Connect
            </a>
          </>
        }
      />
      {backendsLoading && backends.length === 0 ? (
        <Spinner />
      ) : visibleBackends.length > 0 ? (
        <Box className="p-4">
          <AccountTable head={['Name', 'Kind', 'Enabled features', 'Version', 'Last seen', 'Status', '']}>
            {visibleBackends.map((backend) => {
              const canOpen = !backend.revoked_at && backend.kind !== 'frame' && !!backend.origin
              return (
                <tr key={backend.id}>
                  <td className="py-2 pr-3 align-top">
                    <span className="frameos-strong font-medium">{backend.name}</span>
                  </td>
                  <td className="py-2 pr-3 align-top">{backend.kind === 'frame' ? 'Frame' : 'Backend'}</td>
                  <td className="py-2 pr-3 align-top">
                    {backend.features.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {backend.features.map((feature) => (
                          <Tag key={feature}>{feature}</Tag>
                        ))}
                      </div>
                    ) : (
                      <span className="frameos-muted">Link only</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 align-top">{backend.version ?? '–'}</td>
                  <td className="py-2 pr-3 align-top">
                    {backend.last_seen_at ? formatDateTime(backend.last_seen_at) : 'Never'}
                  </td>
                  <td className="py-2 pr-3 align-top">
                    <Tag color={backend.revoked_at ? 'orange' : 'teal'}>
                      {backend.revoked_at ? 'Revoked' : 'Active'}
                    </Tag>
                  </td>
                  <td className="py-2 align-top">
                    <div className="flex items-center justify-end gap-1">
                      {canOpen ? (
                        <a
                          className="frameos-button frameos-secondary-button rounded-md px-2 py-1 text-sm"
                          href={`#backend-${encodeURIComponent(backend.id)}`}
                          onClick={(event) => {
                            // A real link so "open in new tab" works (the
                            // hash reopens the viewer there); a left click
                            // keeps the in-page flow.
                            event.preventDefault()
                            openBackendViewer(backend.id)
                          }}
                          title={`Open ${backend.origin} without leaving FrameOS Cloud`}
                        >
                          Open
                        </a>
                      ) : null}
                      {backend.revoked_at ? null : (
                        <DropdownMenu
                          buttonAriaLabel={`More actions for ${backend.name}`}
                          items={[
                            {
                              label: revokingId === backend.id ? 'Revoking…' : 'Revoke link',
                              disabled: revokingId === backend.id,
                              onClick: () => revokeBackend(backend.id),
                            },
                          ]}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </AccountTable>
        </Box>
      ) : (
        <Box className="p-4 text-sm">
          {backends.length > 0 ? 'No active links. Every link on this account is revoked.' : 'No linked backends yet.'}
        </Box>
      )}
      {openBackend ? <BackendViewer backend={openBackend} /> : null}
    </div>
  )
}

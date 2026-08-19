import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { Button } from '../../../../components/Button'
import { Spinner } from '../../../../components/Spinner'
import { frameLogic } from '../../frameLogic'
import { activityActorLabel, activityLogic, activityRelativeTime } from './activityLogic'

interface ActivityProps {
  scrollContainer?: boolean
}

const absoluteFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

function absoluteTime(iso: string): string {
  const time = Date.parse(iso)
  return Number.isFinite(time) ? absoluteFormatter.format(new Date(time)) : iso
}

/**
 * The frame's audit trail: what the account did to it and what the device
 * reported back (connects, disconnects, scenes applied). Cloud only — see
 * workspaceSurfaces.ts; the logic owns loading, paging and live refresh.
 */
export function Activity({ scrollContainer = true }: ActivityProps = {}) {
  const { frameId } = useValues(frameLogic)
  const { events, hasLoaded, hasOlder, loadingOlder, activityError, activityPageLoading } = useValues(
    activityLogic({ frameId })
  )
  const { loadActivity, loadOlder } = useActions(activityLogic({ frameId }))

  return (
    <div
      className={clsx(
        'frame-tool-panel flex flex-col',
        scrollContainer ? 'h-full min-h-0 overflow-auto' : 'min-h-[calc(100vh-3rem)] overflow-visible'
      )}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">Activity</div>
          <h2 className="frameos-strong truncate text-2xl font-bold tracking-normal text-slate-950">Audit trail</h2>
          <p className="frame-tool-muted mt-1 text-sm">
            Everything the cloud recorded about this frame: commands and pushes from your account, and what the device
            reported back.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {activityPageLoading && hasLoaded ? <Spinner className="h-4 w-4" /> : null}
          <Button size="small" color="secondary" onClick={() => loadActivity()} disabled={activityPageLoading}>
            Refresh
          </Button>
        </div>
      </div>

      {activityError ? (
        <div className="frame-tool-card mb-4 rounded-lg border border-red-300/60 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {activityError}
        </div>
      ) : null}

      {!hasLoaded && activityPageLoading ? (
        <div className="flex items-center gap-2 py-8 text-sm">
          <Spinner className="h-4 w-4" />
          <span className="frame-tool-muted">Loading activity…</span>
        </div>
      ) : events.length === 0 ? (
        <div className="frame-tool-card rounded-lg px-4 py-6 text-center text-sm">
          <div className="frameos-strong font-semibold">No activity recorded yet</div>
          <div className="frame-tool-muted mt-1">
            Pushes, commands, connects and disconnects will show up here as they happen.
          </div>
        </div>
      ) : (
        <div className="frame-tool-card overflow-x-auto rounded-lg">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="frame-tool-muted text-left text-xs font-semibold uppercase tracking-wide">
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Event</th>
                <th className="px-3 py-2">Detail</th>
                <th className="px-3 py-2">Who</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id} className="border-t border-black/5 align-top dark:border-white/10">
                  <td className="whitespace-nowrap px-3 py-2" title={absoluteTime(event.created_at)}>
                    {activityRelativeTime(event)}
                  </td>
                  <td className="px-3 py-2 font-medium" title={event.event_type}>
                    {event.label}
                  </td>
                  <td className="frame-tool-muted break-words px-3 py-2">{event.detail ?? '—'}</td>
                  <td className="frame-tool-muted whitespace-nowrap px-3 py-2">{activityActorLabel(event)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasOlder ? (
        <div className="mt-4 flex justify-center pb-8">
          <Button size="small" color="secondary" onClick={() => loadOlder()} disabled={loadingOlder}>
            {loadingOlder ? 'Loading…' : 'Load older'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

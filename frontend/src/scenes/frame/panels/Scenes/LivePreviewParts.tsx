import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { memo, useEffect, useRef } from 'react'
import { BoltIcon, CursorArrowRaysIcon, FolderOpenIcon } from '@heroicons/react/24/outline'

import { Button } from '../../../../components/Button'
import { Checkbox } from '../../../../components/Checkbox'
import { insertBreaks } from '../../../../utils/insertBreaks'
import { sceneRequiresCompilation } from '../../../../utils/sceneApps'
import { previewSkipsNimMessage } from '../../../../utils/sceneExecution'
import { describeRenderRate, formatFps, type ScenePreviewStatus } from '../../../../utils/scenePreviewDeploy'
import { openBlobInNewTab } from '../../../../utils/objectUrl'
import { livePreviewLogic, type LivePreviewLogLine } from './livePreviewLogic'
import type { FrameId } from '../../../../types'

// The pieces the in-browser preview is made of, shared by the scene editor's
// preview drawer (ScenePreviewPanel) and the template preview modal
// (LivePreviewModal). Every part reads livePreviewLogic for the frame, so a
// host only passes the frame id.

export { describeRenderRate, formatFps }

// Match the real logs' terminal text coloring (see Logs.tsx logTypeClassName).
// The preview's runtime lines are raw strings, so classify them by content.
export function logLineColor(line: string): string {
  if (/error|failed|exception/i.test(line)) {
    return 'text-red-300'
  }
  if (line.startsWith('event:')) {
    return 'text-blue-300'
  }
  return 'text-slate-100'
}

// Same timestamp format as the real logs panel (Logs.tsx formatTimestamp).
export function formatTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  return `${date.getFullYear()}-${date.getMonth() + 1 < 10 ? '0' : ''}${date.getMonth() + 1}-${
    date.getDate() < 10 ? '0' : ''
  }${date.getDate()} ${date.getHours() < 10 ? '0' : ''}${date.getHours()}:${
    date.getMinutes() < 10 ? '0' : ''
  }${date.getMinutes()}:${date.getSeconds() < 10 ? '0' : ''}${date.getSeconds()}`
}

// Open the current canvas image in a new tab. The window is opened
// synchronously so popup blockers count it as user-initiated; the blob URL is
// filled in once the canvas has been encoded.
export function openCanvasImageInNewTab(canvas: HTMLCanvasElement): void {
  const win = window.open('', '_blank')
  canvas.toBlob((blob) => {
    if (!blob) {
      win?.close()
      return
    }
    openBlobInNewTab(blob, win)
  }, 'image/png')
}

// Runtime log lines are mostly JSON like {"event":"debug","message":"..."}.
// Render them the way the real logs panel renders webhook lines: the event
// name highlighted, the remaining keys as key=value pairs.
export function renderLogLine(line: string): JSX.Element | string {
  if (line.startsWith('{')) {
    try {
      const { event, timestamp: _timestamp, ...rest } = JSON.parse(line)
      if (event !== undefined) {
        return (
          <>
            <span className="mr-2 text-yellow-600">{String(event)}</span>
            {Object.entries(rest).map(([key, value]) => (
              <span key={key} className="mr-2">
                <span className="text-gray-400">{key}=</span>
                <span>{insertBreaks(typeof value === 'string' ? value : JSON.stringify(value))}</span>
              </span>
            ))}
          </>
        )
      }
    } catch (e) {
      // fall through to the raw line
    }
  }
  return line
}

/**
 * The status line under the preview surface: what was rendered on the left,
 * the runtime that rendered it on the right. Both texts come from
 * `livePreviewStatusText` (pure, in utils/scenePreviewDeploy.ts).
 */
export function LivePreviewStatusText({
  status,
  className,
}: {
  status: ScenePreviewStatus
  className?: string
}): JSX.Element {
  return (
    <div className={clsx('flex items-center justify-between gap-3 text-xs', className)}>
      <span className={clsx('min-w-0 truncate', status.error ? 'text-red-500' : 'frameos-muted')}>{status.left}</span>
      {status.right ? <span className="frameos-muted shrink-0 truncate">{status.right}</span> : null}
    </div>
  )
}

/** Everything the preview wants to warn about before it renders anything. */
export function LivePreviewNotices({ frameId }: { frameId: FrameId }): JSX.Element | null {
  const { livePreviewScene, previewStatus, previewError, wasmUnsupportedApps, storedKeysNotice } = useValues(
    livePreviewLogic({ frameId })
  )

  const hasNotice =
    (previewStatus === 'error' && previewError) ||
    (livePreviewScene && sceneRequiresCompilation(livePreviewScene)) ||
    wasmUnsupportedApps.length > 0 ||
    storedKeysNotice

  if (!hasNotice) {
    return null
  }

  return (
    <>
      {previewStatus === 'error' && previewError ? (
        <div className="shrink-0 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {previewError}
        </div>
      ) : null}

      {livePreviewScene && sceneRequiresCompilation(livePreviewScene) ? (
        <div
          className="shrink-0 rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-sm text-amber-700"
          data-testid="preview-skips-nim"
        >
          {previewSkipsNimMessage}
        </div>
      ) : null}
      {wasmUnsupportedApps.length > 0 ? (
        <div className="shrink-0 rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-sm text-amber-700">
          This scene uses {wasmUnsupportedApps.length === 1 ? 'an app' : 'apps'} not available in the browser preview:{' '}
          {wasmUnsupportedApps.map((app, index) => (
            <span key={app.keyword}>
              {index > 0 ? ', ' : ''}
              <span className="font-semibold">{app.keyword}</span> ({app.reason})
            </span>
          ))}
          . {wasmUnsupportedApps.length === 1 ? 'That node' : 'Those nodes'} will fail here but{' '}
          {wasmUnsupportedApps.length === 1 ? 'works' : 'work'} on the frame.
        </div>
      ) : null}
      {storedKeysNotice ? (
        <div className="shrink-0 rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-sm text-amber-700">
          {storedKeysNotice}{' '}
          <a
            className="font-semibold underline"
            href={`/login/reauth?return_to=${encodeURIComponent(window.location.href)}`}
          >
            Confirm it is you
          </a>
        </div>
      ) : null}
    </>
  )
}

/** "This scene wants to render every 42 ms — let it go at full speed?" */
export function FastRenderPrompt({ frameId }: { frameId: FrameId }): JSX.Element | null {
  const { fastRenderRequest } = useValues(livePreviewLogic({ frameId }))
  const { setFastMode, dismissFastRenderRequest } = useActions(livePreviewLogic({ frameId }))

  if (!fastRenderRequest || fastRenderRequest.answered) {
    return null
  }

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-sm"
      data-testid="fast-render-request"
    >
      <BoltIcon className="h-5 w-5 shrink-0 text-amber-600" />
      <span className="min-w-0 flex-1">
        This scene wants to render {describeRenderRate(fastRenderRequest.intervalMs)}. The preview is holding it to one
        render per second — let it go at full speed? It will keep your browser busy while the preview is open.
      </span>
      <Button size="small" color="primary" onClick={() => setFastMode(true)}>
        Run at full speed
      </Button>
      <Button size="small" color="secondary" onClick={dismissFastRenderRequest}>
        Keep 1 fps
      </Button>
    </div>
  )
}

/** Re-render, browser assets, the real-time toggle, and the scene's own events. */
export function LivePreviewToolbar({ frameId }: { frameId: FrameId }): JSX.Element {
  const { previewSceneEvents, gpioButtons, lastRenderMs, renderCount, fastMode, fastRenderRequest, measuredFps } =
    useValues(livePreviewLogic({ frameId }))
  const { dispatchPreviewEvent, forcePreviewRender, setFastMode, openPreviewAssets } = useActions(
    livePreviewLogic({ frameId })
  )

  // GPIO buttons get their own dedicated buttons below. Hide "button"
  // scene-event entries: the configured GPIO buttons cover them, and an
  // unlabeled "button" entry sends an event no handler can distinguish.
  const sceneEventButtons = previewSceneEvents.filter((event) => {
    if (event.keyword !== 'button') {
      return true
    }
    if (gpioButtons.length > 0) {
      return false
    }
    return Boolean(event.label)
  })

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <Button size="small" color="secondary" onClick={forcePreviewRender}>
        Re-render
      </Button>
      <Button
        size="small"
        color="secondary"
        className="flex items-center gap-1"
        onClick={openPreviewAssets}
        title="Manage the browser-only asset folder the preview mounts at /srv/assets"
      >
        <FolderOpenIcon className="h-4 w-4" />
        Browser assets
      </Button>
      {fastRenderRequest?.answered ? (
        <Checkbox
          value={fastMode}
          onChange={(checked) => setFastMode(checked)}
          label={
            fastMode && measuredFps !== null
              ? `Real-time rendering · ${formatFps(measuredFps)} fps`
              : `Real-time rendering (the scene asks for ~${formatFps(
                  1000 / Math.max(1, fastRenderRequest.intervalMs)
                )} fps)`
          }
          title="Let the scene render as often as it asks instead of once per second"
        />
      ) : null}
      {sceneEventButtons.map((event) => (
        <Button
          key={`${event.keyword}:${event.label ?? ''}`}
          size="small"
          color="secondary"
          onClick={() => dispatchPreviewEvent(event.keyword, event.label ? { label: event.label } : {})}
        >
          {event.keyword}
          {event.label ? `: ${event.label}` : ''}
        </Button>
      ))}
      {gpioButtons.map((button) => (
        <Button
          key={`gpio:${button.pin}`}
          size="small"
          color="secondary"
          className="flex items-center gap-1"
          title={`GPIO pin ${button.pin}`}
          onClick={() =>
            // Same event the device's GPIO driver sends on a button
            // press (level 0 = falling edge).
            dispatchPreviewEvent('button', { pin: button.pin, label: button.label, level: 0 })
          }
        >
          <CursorArrowRaysIcon className="h-4 w-4" />
          {button.label || `GPIO ${button.pin}`}
        </Button>
      ))}
      <span className="frameos-muted ml-auto text-xs">
        {renderCount > 0 ? (
          <>
            {renderCount} render{renderCount === 1 ? '' : 's'}
            {lastRenderMs !== null ? `, last ${lastRenderMs} ms` : ''}
          </>
        ) : null}
      </span>
    </div>
  )
}

// One runtime log line. Memoized with a stable key: a scene rendering at
// full speed appends lines many times a second, and only the new rows
// should cost anything.
const LogRow = memo(function LogRow({ log }: { log: LivePreviewLogLine }): JSX.Element {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 whitespace-nowrap text-slate-500">{formatTimestamp(log.timestamp)}</div>
      <div className={clsx('min-w-0 flex-1 break-words', logLineColor(log.line))} style={{ wordBreak: 'break-word' }}>
        {renderLogLine(log.line)}
      </div>
    </div>
  )
})

/** The runtime log, stuck to the bottom unless the user scrolled up. */
export function LivePreviewLogs({ frameId, className }: { frameId: FrameId; className?: string }): JSX.Element {
  const { previewLogs } = useValues(livePreviewLogic({ frameId }))

  // Stick the runtime log to the bottom as new lines arrive, like the real
  // logs — but only while the user hasn't scrolled up to read older lines.
  const logRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  useEffect(() => {
    const el = logRef.current
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [previewLogs])

  return (
    <div className={clsx('flex min-h-[8rem] flex-col gap-1', className)}>
      <div className="frameos-muted shrink-0 text-xs font-semibold uppercase">Runtime log</div>
      <div
        ref={logRef}
        onScroll={(event) => {
          const el = event.currentTarget
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-white/10 bg-slate-900 p-2 font-mono text-sm leading-5"
      >
        {previewLogs.length > 0 ? (
          previewLogs.map((log) => <LogRow key={log.id} log={log} />)
        ) : (
          <div className="flex h-full items-center justify-center text-slate-500">No logs yet</div>
        )}
      </div>
    </div>
  )
}

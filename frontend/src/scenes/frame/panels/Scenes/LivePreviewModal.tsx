import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'

import { Button } from '../../../../components/Button'
import { Checkbox } from '../../../../components/Checkbox'
import { Modal } from '../../../../components/Modal'
import { Spinner } from '../../../../components/Spinner'
import { livePreviewLogic } from './livePreviewLogic'

// Match the real logs' terminal text coloring (see Logs.tsx logTypeClassName).
// The preview's runtime lines are raw strings, so classify them by content.
function logLineColor(line: string): string {
  if (/error|failed|exception/i.test(line)) {
    return 'text-red-300'
  }
  if (line.startsWith('event:')) {
    return 'text-blue-300'
  }
  return 'text-slate-100'
}

// Same timestamp format as the real logs panel (Logs.tsx formatTimestamp).
function formatTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  return `${date.getFullYear()}-${date.getMonth() + 1 < 10 ? '0' : ''}${date.getMonth() + 1}-${
    date.getDate() < 10 ? '0' : ''
  }${date.getDate()} ${date.getHours() < 10 ? '0' : ''}${date.getHours()}:${
    date.getMinutes() < 10 ? '0' : ''
  }${date.getMinutes()}:${date.getSeconds() < 10 ? '0' : ''}${date.getSeconds()}`
}

export function LivePreviewModal({ frameId }: { frameId: number }): JSX.Element | null {
  const {
    livePreviewSceneId,
    livePreviewScene,
    previewStatus,
    previewError,
    previewLogs,
    previewState,
    previewSceneEvents,
    previewDimensions,
    lastRenderMs,
    renderCount,
  } = useValues(livePreviewLogic({ frameId }))
  const { closeLivePreview, registerCanvas, dispatchPreviewEvent, forcePreviewRender } = useActions(
    livePreviewLogic({ frameId })
  )

  const [showPublicState, setShowPublicState] = useState(true)
  const [showPrivateState, setShowPrivateState] = useState(false)

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

  if (!livePreviewSceneId) {
    return null
  }

  const publicFieldNames = new Set(
    (livePreviewScene?.fields ?? []).filter((field) => field.access === 'public').map((field) => field.name)
  )
  const stateEntries = Object.entries(previewState)
  const publicEntries = stateEntries.filter(([key]) => publicFieldNames.has(key))
  const privateEntries = stateEntries.filter(([key]) => !publicFieldNames.has(key))
  const visibleStateEntries = [
    ...(showPublicState ? publicEntries : []),
    ...(showPrivateState ? privateEntries : []),
  ]

  return (
    <Modal
      open
      onClose={closeLivePreview}
      title={`In-browser preview: ${livePreviewScene?.name ?? 'scene'}`}
      panelClassName="max-w-[960px]"
      bodyClassName="h-[calc(100dvh-9rem)]"
    >
      <div className="flex h-full min-h-0 flex-col gap-4 p-5">
        <div className="relative flex shrink-0 items-center justify-center rounded-lg bg-slate-900/90 p-2">
          <canvas
            ref={registerCanvas}
            width={previewDimensions.width}
            height={previewDimensions.height}
            className="max-h-[50vh] max-w-full rounded border border-white/10"
            style={{ imageRendering: 'pixelated', aspectRatio: `${previewDimensions.width} / ${previewDimensions.height}` }}
          />
          {previewStatus === 'loading' ? (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white">
              <Spinner color="white" />
              Rendering scene in your browser…
            </div>
          ) : null}
        </div>

        {previewStatus === 'error' && previewError ? (
          <div className="shrink-0 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            {previewError}
          </div>
        ) : null}

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button size="small" color="secondary" onClick={forcePreviewRender}>
            Re-render
          </Button>
          {previewSceneEvents.map((event) => (
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
          <span className="frameos-muted ml-auto text-xs">
            {renderCount > 0 ? (
              <>
                {renderCount} render{renderCount === 1 ? '' : 's'}
                {lastRenderMs !== null ? `, last ${lastRenderMs} ms` : ''}
              </>
            ) : null}
          </span>
        </div>

        {stateEntries.length > 0 ? (
          <div className="shrink-0 space-y-1">
            <div className="flex flex-wrap items-center gap-4">
              <div className="frameos-muted text-xs font-semibold uppercase">Scene state</div>
              <Checkbox
                value={showPublicState}
                onChange={setShowPublicState}
                label={`public (${publicEntries.length})`}
              />
              <Checkbox
                value={showPrivateState}
                onChange={setShowPrivateState}
                label={`private (${privateEntries.length})`}
              />
            </div>
            <div className="max-h-40 overflow-y-auto rounded-lg border border-white/10 bg-slate-900 p-2 font-mono text-xs">
              {visibleStateEntries.length > 0 ? (
                visibleStateEntries.map(([key, value]) => (
                  <div key={key} className="break-all">
                    <span className="text-slate-400">{key}</span>
                    <span className="text-slate-500">: </span>
                    <span className="text-slate-100">
                      {typeof value === 'string' ? value : JSON.stringify(value)}
                    </span>
                  </div>
                ))
              ) : (
                <div className="text-slate-500">No state fields selected</div>
              )}
            </div>
          </div>
        ) : null}

        <div className="flex min-h-[8rem] flex-1 flex-col gap-1">
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
              previewLogs.map((log, index) => (
                <div key={index} className="flex gap-2">
                  <div className="shrink-0 whitespace-nowrap text-slate-500">{formatTimestamp(log.timestamp)}</div>
                  <div
                    className={clsx('min-w-0 flex-1 break-words', logLineColor(log.line))}
                    style={{ wordBreak: 'break-word' }}
                  >
                    {log.line}
                  </div>
                </div>
              ))
            ) : (
              <div className="flex h-full items-center justify-center text-slate-500">No logs yet</div>
            )}
          </div>
        </div>

        <div className="frameos-muted shrink-0 text-xs">
          Runs the scene with the FrameOS interpreter compiled to WebAssembly, in your browser. Apps that fetch
          external URLs are routed through the backend to get around browser CORS restrictions, so images and data
          load — the device itself fetches them directly. Device-only apps (screenshots, camera snapshots) are
          unavailable.
        </div>
      </div>
    </Modal>
  )
}

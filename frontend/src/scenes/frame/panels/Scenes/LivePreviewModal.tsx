import { useActions, useValues } from 'kea'

import { Button } from '../../../../components/Button'
import { Modal } from '../../../../components/Modal'
import { Spinner } from '../../../../components/Spinner'
import { livePreviewLogic } from './livePreviewLogic'

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

  if (!livePreviewSceneId) {
    return null
  }

  const stateEntries = Object.entries(previewState)

  return (
    <Modal open onClose={closeLivePreview} title={`Live preview: ${livePreviewScene?.name ?? 'scene'}`}>
      <div className="space-y-4 p-5">
        <div className="relative flex items-center justify-center rounded-lg bg-slate-900/90 p-2">
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
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">{previewError}</div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
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
          <div className="space-y-1">
            <div className="frameos-muted text-xs font-semibold uppercase">Scene state</div>
            <div className="rounded-lg bg-slate-100/80 p-2 font-mono text-xs dark:bg-slate-800/80">
              {stateEntries.map(([key, value]) => (
                <div key={key}>
                  {key}: {typeof value === 'string' ? value : JSON.stringify(value)}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {previewLogs.length > 0 ? (
          <div className="space-y-1">
            <div className="frameos-muted text-xs font-semibold uppercase">Runtime log</div>
            <pre className="max-h-40 overflow-y-auto rounded-lg bg-slate-100/80 p-2 text-xs dark:bg-slate-800/80">
              {previewLogs.slice(-50).join('\n')}
            </pre>
          </div>
        ) : null}

        <div className="frameos-muted text-xs">
          Runs the scene with the FrameOS interpreter compiled to WebAssembly, in your browser. Apps that fetch
          external URLs go through the backend (like the device does), so images and data load. Device-only apps
          (screenshots, camera snapshots) are unavailable.
        </div>
      </div>
    </Modal>
  )
}

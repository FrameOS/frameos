import { useActions, useValues } from 'kea'
import { Form } from 'kea-forms'
import clsx from 'clsx'

import { Button } from '../../../../components/Button'
import { Field } from '../../../../components/Field'
import { FrameImage } from '../../../../components/FrameImage'
import { Spinner } from '../../../../components/Spinner'
import { FrameImageOverlayControls } from '../../../workspace/FrameImageOverlayControls'
import { isFrameControlMode } from '../../../../utils/frameControlMode'
import { livePreviewStatusText } from '../../../../utils/scenePreviewDeploy'
import { BrowserAssetsModal } from './BrowserAssetsModal'
import { expandedSceneLogic } from './expandedSceneLogic'
import { livePreviewLogic, livePreviewUnavailableMessage } from './livePreviewLogic'
import {
  FastRenderPrompt,
  LivePreviewLogs,
  LivePreviewNotices,
  LivePreviewStatusText,
  LivePreviewToolbar,
  openCanvasImageInNewTab,
} from './LivePreviewParts'
import { scenePreviewPanelLogic } from './scenePreviewPanelLogic'
import { StateFieldEdit } from './StateFieldEdit'
import type { FrameId, FrameScene } from '../../../../types'

// The scene editor's Preview drawer, in three pinned pieces: the picture at
// the top, the scene's fields (and the live preview's extras) scrolling in
// the middle, the two buttons always in the fold at the bottom. Both hosts —
// the scene workspace's utility drawer and the frame dashboard's scene
// control drawer — arrange the same three parts.

export interface ScenePreviewPanelProps {
  frameId: FrameId
  sceneId: string
  /** For a scene the frame reports but the form does not hold (an uploaded scene). */
  scene?: FrameScene | null
}

/** The picture never takes more than this much of the drawer. */
const PREVIEW_MAX_HEIGHT = 'min(40vh, 400px)'

/** The picture (or the live canvas) plus the one-line status under it. */
export function ScenePreviewSurface({ frameId, sceneId, scene }: ScenePreviewPanelProps): JSX.Element {
  const logicProps = { frameId, sceneId, scene }
  const { surface, deployNotice, showFrameImage, snapshotMissing } = useValues(scenePreviewPanelLogic(logicProps))
  const { frame } = useValues(expandedSceneLogic(logicProps))
  const { setSnapshotMissing } = useActions(scenePreviewPanelLogic(logicProps))
  const { previewDimensions, previewStatus, previewError, lastRenderMs, measuredFps, fastMode, runtimeVersion } =
    useValues(livePreviewLogic({ frameId }))
  const { registerCanvas } = useActions(livePreviewLogic({ frameId }))

  const { width, height } = previewDimensions
  const status = livePreviewStatusText({
    surface,
    previewStatus,
    previewError,
    renderWidth: width,
    renderHeight: height,
    lastRenderMs,
    measuredFps,
    fastMode,
    runtimeVersion,
    hasSnapshot: !snapshotMissing,
    deployNotice,
  })

  // The box is exactly the frame's shape, capped by height: without the width
  // cap an aspect-ratio box stays full width and letterboxes inside itself.
  const boxStyle = {
    aspectRatio: `${width} / ${height}`,
    width: `min(100%, calc(${PREVIEW_MAX_HEIGHT} * ${width / height}))`,
  }
  // The frame's own panel image once a deploy landed; the scene's snapshot
  // otherwise.
  const showingFrameImage = surface === 'frame' || (surface === 'pending' && showFrameImage)

  return (
    <div className="space-y-1">
      <div
        className="frameos-card-media relative mx-auto flex items-center justify-center overflow-hidden rounded-lg bg-slate-100"
        style={boxStyle}
      >
        {surface === 'live' ? (
          <>
            <canvas
              ref={registerCanvas}
              width={width}
              height={height}
              className="h-full w-full cursor-zoom-in"
              title="Open image in a new tab"
              onClick={(event) => openCanvasImageInNewTab(event.currentTarget)}
              style={{ imageRendering: 'pixelated', objectFit: 'contain' }}
            />
            {previewStatus === 'loading' ? (
              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-white/70 text-sm">
                <Spinner />
                Rendering scene in your browser…
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className={clsx('h-full w-full', surface === 'pending' ? 'opacity-40' : null)}>
              <FrameImage
                frameId={frameId}
                // After a deploy settled the surface shows the frame's own
                // panel image ("that image"), not the older scene snapshot.
                sceneId={showingFrameImage ? undefined : sceneId}
                objectFit="contain"
                refreshable={false}
                className="h-full w-full max-h-full max-w-full"
                imageClassName="max-h-full max-w-full"
                onMissing={setSnapshotMissing}
              />
            </div>
            {/* The badge and the refresh button the sidebar's frame preview
                used to carry, now that this is the only picture on the page. */}
            {frame && surface !== 'pending' ? (
              <FrameImageOverlayControls
                frame={frame}
                sceneId={showingFrameImage ? undefined : sceneId}
                showPreview={false}
              />
            ) : null}
            {surface === 'pending' ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm">
                <Spinner />
                <span className="frameos-muted">Waiting for the frame to render…</span>
              </div>
            ) : null}
            {surface === 'snapshot' && snapshotMissing ? (
              <div className="frameos-muted absolute inset-0 flex items-center justify-center px-4 text-center text-xs">
                No snapshot yet. Preview in browser or deploy to frame to render it.
              </div>
            ) : null}
          </>
        )}
      </div>
      <LivePreviewStatusText status={status} />
    </div>
  )
}

/** The scrolling middle: the live preview's extras, the scene's fields, the log. */
export function ScenePreviewBody({ frameId, sceneId, scene }: ScenePreviewPanelProps): JSX.Element {
  const logicProps = { frameId, sceneId, scene }
  const { surface } = useValues(scenePreviewPanelLogic(logicProps))
  const { visibleFields, stateChanges, currentState } = useValues(expandedSceneLogic(logicProps))
  const live = surface === 'live'

  return (
    <div className="space-y-3">
      {live ? (
        <>
          <LivePreviewNotices frameId={frameId} />
          <FastRenderPrompt frameId={frameId} />
          <LivePreviewToolbar frameId={frameId} />
        </>
      ) : null}

      {visibleFields.length === 0 ? (
        <div className="frameos-muted text-sm">This scene has no fields</div>
      ) : (
        <Form logic={expandedSceneLogic} props={logicProps} formKey="stateChanges" className="space-y-2 @container">
          {visibleFields.map((field) => (
            <Field
              key={field.name}
              name={field.name}
              label={
                <>
                  {field.label || field.name}
                  {field.name in stateChanges && stateChanges[field.name] !== (currentState[field.name] ?? field.value)
                    ? ' (modified)'
                    : ''}
                </>
              }
            >
              {({ value, onChange }) => (
                <StateFieldEdit
                  field={field}
                  value={value}
                  onChange={onChange}
                  currentState={currentState}
                  stateChanges={stateChanges}
                  frameId={frameId}
                />
              )}
            </Field>
          ))}
        </Form>
      )}

      {live ? (
        <>
          <LivePreviewLogs frameId={frameId} className="max-h-72" />
          <div className="frameos-muted text-xs">
            Runs the scene with the FrameOS interpreter compiled to WebAssembly, in your browser.{' '}
            {isFrameControlMode() ? (
              <>
                Apps that fetch external URLs go straight out of your browser — the frame serves no proxy, so some of
                them can be blocked here while they work on the frame.
              </>
            ) : (
              <>
                Apps that fetch external URLs are routed through a same-origin proxy to get around browser CORS
                restrictions, so images and data load — the device itself fetches them directly.
              </>
            )}{' '}
            <code>/srv/assets</code> is a folder that lives only in this browser (“Browser assets” above), not the
            frame's real assets. Device-only apps (screenshots, camera snapshots) are unavailable.
          </div>
        </>
      ) : null}

      <BrowserAssetsModal frameId={frameId} />
    </div>
  )
}

/** The two buttons (plus Reset) that stay in the fold. */
export function ScenePreviewFooter({ frameId, sceneId, scene }: ScenePreviewPanelProps): JSX.Element {
  const logicProps = { frameId, sceneId, scene }
  const { surface, deployPending } = useValues(scenePreviewPanelLogic(logicProps))
  const { startBrowserPreview, stopBrowserPreview } = useActions(scenePreviewPanelLogic(logicProps))
  const { livePreviewAvailability } = useValues(livePreviewLogic({ frameId }))
  const { visibleFields, deployDescription } = useValues(expandedSceneLogic(logicProps))
  // The deploy itself belongs to expandedSceneLogic; scenePreviewPanelLogic
  // watches the same action, so the diagram toolbar's button spins this
  // surface too.
  const { deployToFrame, resetStateChanges } = useActions(expandedSceneLogic(logicProps))

  const live = surface === 'live'
  const runtimeMissing = livePreviewAvailability === 'missing'

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        color="secondary"
        data-testid="scene-preview-browser"
        disabled={runtimeMissing && !live}
        title={runtimeMissing ? livePreviewUnavailableMessage() : 'Run this scene in your browser via WebAssembly'}
        onClick={() => (live ? stopBrowserPreview() : startBrowserPreview())}
      >
        {live ? 'Stop preview' : 'Preview in browser'}
      </Button>
      <Button
        color="primary"
        data-testid="scene-deploy-frame"
        className="flex items-center gap-2"
        disabled={deployPending}
        aria-busy={deployPending || undefined}
        title={deployDescription}
        onClick={() => deployToFrame()}
      >
        {deployPending ? <Spinner color="white" className="shrink-0" /> : null}
        Deploy to frame
      </Button>
      {visibleFields.length > 0 ? (
        <Button color="secondary" data-testid="scene-reset-fields" onClick={() => resetStateChanges()}>
          Reset
        </Button>
      ) : null}
    </div>
  )
}

/** The three parts stacked, for a host without its own pinned chrome. */
export function ScenePreviewPanel({ frameId, sceneId, scene }: ScenePreviewPanelProps): JSX.Element {
  return (
    <div className="space-y-3">
      <ScenePreviewSurface frameId={frameId} sceneId={sceneId} scene={scene} />
      <ScenePreviewBody frameId={frameId} sceneId={sceneId} scene={scene} />
      <ScenePreviewFooter frameId={frameId} sceneId={sceneId} scene={scene} />
    </div>
  )
}

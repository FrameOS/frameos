import { useActions, useValues } from 'kea'
import { useEffect, useRef, useState } from 'react'
import { CheckIcon, FolderPlusIcon, PencilSquareIcon } from '@heroicons/react/24/outline'

import { Button } from '../../../../components/Button'
import { Checkbox } from '../../../../components/Checkbox'
import { Label } from '../../../../components/Label'
import { Modal } from '../../../../components/Modal'
import { Spinner } from '../../../../components/Spinner'
import { visiblePublicStateFields } from '../../../../utils/showIf'
import { frameLogic } from '../../frameLogic'
import { templatesLogic } from '../Templates/templatesLogic'
import { BrowserAssetsModal } from './BrowserAssetsModal'
import { livePreviewLogic } from './livePreviewLogic'
import {
  FastRenderPrompt,
  LivePreviewLogs,
  LivePreviewNotices,
  LivePreviewToolbar,
  openCanvasImageInNewTab,
} from './LivePreviewParts'
import { scenesLogic } from './scenesLogic'
import { StateFieldEdit } from './StateFieldEdit'
import type { FrameId } from '../../../../types'

// The modal is now only the template-preview host (Templates/Template.tsx):
// the scene editor previews inline in its Preview drawer (ScenePreviewPanel).
// Its pieces live in LivePreviewParts.tsx, shared by both.
//
// Re-exported so the npm embed's own preview (src/embed/EmbedScenePreview.tsx)
// and anything else that imported them from here keeps working.
export {
  describeRenderRate,
  formatFps,
  formatTimestamp,
  logLineColor,
  openCanvasImageInNewTab,
  renderLogLine,
} from './LivePreviewParts'

// The preview can be hosted from several components (scene card, diagram
// toolbar, template row) that may be mounted at the same time. Only ONE of
// them may render the dialog: two identical stacked dialogs close each other,
// because a click inside one counts as an outside-click for the other.
const modalHostStacks = new Map<FrameId, symbol[]>()
const modalHostListeners = new Map<FrameId, Set<() => void>>()

function useLivePreviewModalOwnership(frameId: FrameId): boolean {
  const idRef = useRef<symbol | null>(null)
  if (idRef.current === null) {
    idRef.current = Symbol('LivePreviewModal')
  }
  const id = idRef.current
  const [, forceRender] = useState(0)
  useEffect(() => {
    const stack = modalHostStacks.get(frameId) ?? []
    stack.push(id)
    modalHostStacks.set(frameId, stack)
    const notify = () => forceRender((count) => count + 1)
    const notifiers = modalHostListeners.get(frameId) ?? new Set()
    notifiers.add(notify)
    modalHostListeners.set(frameId, notifiers)
    notifiers.forEach((fn) => fn())
    return () => {
      modalHostStacks.set(
        frameId,
        (modalHostStacks.get(frameId) ?? []).filter((hostId) => hostId !== id)
      )
      notifiers.delete(notify)
      // Ownership may have moved to another mounted host — let them recheck.
      notifiers.forEach((fn) => fn())
    }
  }, [frameId, id])
  return (modalHostStacks.get(frameId) ?? [])[0] === id
}

export function LivePreviewModal({ frameId }: { frameId: FrameId }): JSX.Element | null {
  const isModalOwner = useLivePreviewModalOwnership(frameId)
  const {
    livePreviewSceneId,
    livePreviewScene,
    livePreviewSourceTemplate,
    previewStatus,
    previewState,
    previewDimensions,
  } = useValues(livePreviewLogic({ frameId }))
  const { closeLivePreview, registerCanvas, dispatchPreviewEvent } = useActions(livePreviewLogic({ frameId }))
  const { scenes: frameScenes } = useValues(scenesLogic({ frameId }))
  const { applyTemplate } = useActions(frameLogic({ frameId }))
  const { applyRemoteToFrame } = useActions(templatesLogic({ frameId }))

  const [showPublicState, setShowPublicState] = useState(true)
  const [showPrivateState, setShowPrivateState] = useState(false)
  // Non-null while the "edit state" modal is open; holds the edited values.
  const [editStateValues, setEditStateValues] = useState<Record<string, any> | null>(null)

  if (!livePreviewSceneId || !isModalOwner) {
    return null
  }

  const publicFields = (livePreviewScene?.fields ?? []).filter((field) => field.access === 'public')
  const publicFieldNames = new Set(publicFields.map((field) => field.name))
  const stateEntries = Object.entries(previewState)
  const publicEntries = stateEntries.filter(([key]) => publicFieldNames.has(key))
  const privateEntries = stateEntries.filter(([key]) => !publicFieldNames.has(key))
  const visibleStateEntries = [...(showPublicState ? publicEntries : []), ...(showPrivateState ? privateEntries : [])]

  const openEditState = (): void => {
    const values: Record<string, any> = {}
    for (const field of publicFields) {
      values[field.name] = previewState[field.name] ?? field.value
    }
    setEditStateValues(values)
  }

  // "Install on frame": offered when the preview was opened from a template row.
  // Installed templates are matched by scene name, same as the template list.
  const sourceTemplateAdded = Boolean(
    livePreviewSourceTemplate && frameScenes.some((scene) => scene.name === livePreviewSourceTemplate.template.name)
  )
  const addToFrameButton = livePreviewSourceTemplate ? (
    <Button
      size="tiny"
      color="secondary"
      className="!px-2 flex items-center gap-1"
      disabled={sourceTemplateAdded}
      onClick={() => {
        if (livePreviewSourceTemplate.repository) {
          applyRemoteToFrame(livePreviewSourceTemplate.repository, livePreviewSourceTemplate.template)
        } else {
          applyTemplate(livePreviewSourceTemplate.template)
        }
      }}
      title={
        sourceTemplateAdded
          ? 'This scene is already on the frame'
          : 'Install this scene on the frame (saved when you save the frame)'
      }
    >
      {sourceTemplateAdded ? <CheckIcon className="h-4 w-4" /> : <FolderPlusIcon className="h-4 w-4" />}
      {sourceTemplateAdded ? 'Installed' : 'Install on frame'}
    </Button>
  ) : null

  const submitEditState = (): void => {
    if (!editStateValues) {
      return
    }
    const state: Record<string, any> = {}
    for (const field of visiblePublicStateFields(publicFields, previewState, editStateValues)) {
      const value = editStateValues[field.name] ?? field.value
      if (value !== undefined && value !== null) {
        state[field.name] = String(value)
      }
    }
    dispatchPreviewEvent('setSceneState', { state, render: true })
    setEditStateValues(null)
  }

  const editableFields = editStateValues ? visiblePublicStateFields(publicFields, previewState, editStateValues) : []

  return (
    <Modal
      open
      onClose={closeLivePreview}
      title={`Browser preview: ${livePreviewScene?.name ?? 'scene'}`}
      panelClassName="max-w-[960px]"
      bodyClassName="h-[calc(100dvh-9rem)]"
    >
      <>
        <div className="flex h-full min-h-0 flex-col gap-4 p-5">
          <div className="relative flex shrink-0 items-center justify-center">
            <canvas
              ref={registerCanvas}
              width={previewDimensions.width}
              height={previewDimensions.height}
              className="max-h-[50vh] max-w-full cursor-zoom-in"
              title="Open image in a new tab"
              onClick={(event) => openCanvasImageInNewTab(event.currentTarget)}
              style={{
                imageRendering: 'pixelated',
                aspectRatio: `${previewDimensions.width} / ${previewDimensions.height}`,
              }}
            />
            {previewStatus === 'loading' ? (
              <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm">
                <Spinner />
                Rendering scene in your browser…
              </div>
            ) : null}
          </div>

          <LivePreviewNotices frameId={frameId} />
          <FastRenderPrompt frameId={frameId} />
          <LivePreviewToolbar frameId={frameId} />

          <div className="shrink-0 space-y-1">
            <div className="flex flex-wrap items-center gap-4">
              <div className="frameos-muted text-xs font-semibold uppercase">Scene state</div>
              {stateEntries.length > 0 ? (
                <>
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
                </>
              ) : null}
              {publicFields.length > 0 ? (
                <Button
                  size="tiny"
                  color="secondary"
                  className="!px-2 flex items-center gap-1"
                  onClick={openEditState}
                  title="Edit the scene's public state and update the preview"
                >
                  <PencilSquareIcon className="h-4 w-4" />
                  Edit
                </Button>
              ) : null}
              {addToFrameButton}
            </div>
            {stateEntries.length > 0 ? (
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
            ) : null}
          </div>

          <LivePreviewLogs frameId={frameId} className="flex-1" />

          <div className="frameos-muted shrink-0 text-xs">
            Runs the scene with the FrameOS interpreter compiled to WebAssembly, in your browser. Apps that fetch
            external URLs are routed through a same-origin proxy to get around browser CORS restrictions, so images and
            data load — the device itself fetches them directly. <code>/srv/assets</code> is a folder that lives only in
            this browser (“Browser assets” above), not the frame's real assets. Device-only apps (screenshots, camera
            snapshots) are unavailable.
          </div>
        </div>

        <BrowserAssetsModal frameId={frameId} />

        {editStateValues ? (
          <Modal
            open
            onClose={() => setEditStateValues(null)}
            title={`Scene state: ${livePreviewScene?.name ?? 'scene'}`}
          >
            <div className="space-y-4 p-5">
              {editableFields.length > 0 ? (
                <div className="space-y-2 @container">
                  {editableFields.map((field) => (
                    <div key={field.name} className="space-y-1">
                      <Label>{field.label || field.name}</Label>
                      <StateFieldEdit
                        field={field}
                        value={editStateValues[field.name]}
                        onChange={(value) => setEditStateValues((values) => ({ ...values, [field.name]: value }))}
                        currentState={previewState}
                        stateChanges={editStateValues}
                        frameId={frameId}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="frameos-muted text-sm">This scene does not export publicly controllable state.</div>
              )}
              <div className="flex justify-end gap-2 border-t border-slate-500/20 pt-4">
                <Button onClick={() => setEditStateValues(null)} color="secondary">
                  Cancel
                </Button>
                <Button onClick={submitEditState} color="primary">
                  Update preview
                </Button>
              </div>
            </div>
          </Modal>
        ) : null}
      </>
    </Modal>
  )
}

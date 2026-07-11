import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CursorArrowRaysIcon, KeyIcon, PencilSquareIcon } from '@heroicons/react/24/outline'

import { Button } from '../components/Button'
import { Checkbox } from '../components/Checkbox'
import { Label } from '../components/Label'
import { Modal } from '../components/Modal'
import { Spinner } from '../components/Spinner'
import { TextInput } from '../components/TextInput'
import { Tooltip } from '../components/Tooltip'
import { visiblePublicStateFields } from '../utils/showIf'
import { appsModel } from '../models/appsModel'
import { collectSecretSettingsFromScenes, settingsDetails } from '../scenes/frame/panels/secretSettings'
import { collectScenePreviewPayloadScenes } from '../scenes/frame/panels/Scenes/scenesLogic'
import { livePreviewLogic } from '../scenes/frame/panels/Scenes/livePreviewLogic'
import {
  formatTimestamp,
  logLineColor,
  openCanvasImageInNewTab,
  renderLogLine,
} from '../scenes/frame/panels/Scenes/LivePreviewModal'
import { StateFieldEdit } from '../scenes/frame/panels/Scenes/StateFieldEdit'

// The Preview drawer panel of the standalone embedded editor: runs the edited
// scenes through the frameos-wasm runtime, in the browser — canvas, event
// buttons, live scene state and the runtime log. Same livePreviewLogic as the
// main app's "Preview in browser" modal, rendered as panel content and
// without the frame-dependent actions (there is no frame to preview on).
export function EmbedScenePreview({ frameId, sceneId }: { frameId: number; sceneId: string }): JSX.Element {
  const {
    livePreviewScene,
    previewStatus,
    previewError,
    previewLogs,
    previewState,
    previewSceneEvents,
    previewDimensions,
    gpioButtons,
    wasmUnsupportedApps,
    lastRenderMs,
    renderCount,
    previewSettings,
    scenes,
  } = useValues(livePreviewLogic({ frameId }))
  const {
    openLivePreview,
    closeLivePreview,
    registerCanvas,
    dispatchPreviewEvent,
    forcePreviewRender,
    setPreviewSettings,
  } = useActions(livePreviewLogic({ frameId }))
  const { apps } = useValues(appsModel)

  const [showPublicState, setShowPublicState] = useState(true)
  const [showPrivateState, setShowPrivateState] = useState(false)
  // Non-null while the "edit state" modal is open; holds the edited values.
  const [editStateValues, setEditStateValues] = useState<Record<string, any> | null>(null)

  // API keys (etc.) the previewed scenes' apps need. Typed values live here
  // per flat "group.field" key; "Apply" nests them into the settings object
  // the runtime expects and restarts the preview. Seeded from the previously
  // applied settings so reopening the panel shows them.
  const [settingsForm, setSettingsForm] = useState<Record<string, string>>(() => {
    const flat: Record<string, string> = {}
    for (const [group, groupValues] of Object.entries(previewSettings ?? {})) {
      for (const [key, value] of Object.entries(groupValues ?? {})) {
        if (typeof value === 'string') {
          flat[`${group}.${key}`] = value
        }
      }
    }
    return flat
  })
  const requiredSettingKeys = useMemo(() => {
    const scene = scenes.find((item) => item.id === sceneId)
    const payloadScenes = scene ? collectScenePreviewPayloadScenes(scene, scenes, null) : []
    return collectSecretSettingsFromScenes(payloadScenes, apps)
  }, [scenes, sceneId, apps])

  const applySettings = (): void => {
    const nested: Record<string, Record<string, any>> = {}
    for (const settingKey of requiredSettingKeys) {
      for (const field of settingsDetails[settingKey]?.fields ?? []) {
        const value = settingsForm[field.path.join('.')]?.trim()
        if (value) {
          const [group, key] = field.path as [string, string]
          nested[group] = { ...(nested[group] ?? {}), [key]: value }
        }
      }
    }
    setPreviewSettings(nested)
  }

  // The wasm runtime starts when the panel opens and stops when it closes;
  // switching scenes restarts it on the newly selected scene.
  useEffect(() => {
    openLivePreview(sceneId)
    return () => closeLivePreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneId])

  // Stick the runtime log to the bottom as new lines arrive — but only while
  // the user hasn't scrolled up to read older lines.
  const logRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  useEffect(() => {
    const el = logRef.current
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [previewLogs])

  // GPIO buttons get dedicated buttons; hide indistinguishable "button"
  // scene-event entries (same rule as LivePreviewModal).
  const sceneEventButtons = previewSceneEvents.filter((event) => {
    if (event.keyword !== 'button') {
      return true
    }
    if (gpioButtons.length > 0) {
      return false
    }
    return Boolean(event.label)
  })

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
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="relative flex shrink-0 items-center justify-center">
        <canvas
          ref={registerCanvas}
          width={previewDimensions.width}
          height={previewDimensions.height}
          className="max-h-[40vh] max-w-full cursor-zoom-in rounded-lg border border-slate-500/20"
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

      {previewStatus === 'error' && previewError ? (
        <div className="shrink-0 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {previewError}
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
          {wasmUnsupportedApps.length === 1 ? 'works' : 'work'} on a frame.
        </div>
      ) : null}

      {requiredSettingKeys.length > 0 ? (
        <div className="frame-tool-row shrink-0 space-y-3 rounded-xl p-3">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <KeyIcon className="h-4 w-4 shrink-0" />
            This scene uses services that need API keys
          </div>
          <div className="frame-tool-muted text-xs">
            Keys stay in this browser tab and are used only by the preview.
          </div>
          {requiredSettingKeys.map((settingKey) => {
            const details = settingsDetails[settingKey]
            if (!details) {
              return null
            }
            return (
              <div key={settingKey} className="space-y-1.5">
                <div className="frameos-muted text-xs font-semibold uppercase tracking-wide">{details.title}</div>
                {details.fields.map((field) => {
                  const formKey = field.path.join('.')
                  return (
                    <label key={formKey} className="block space-y-1">
                      {/* Labels come from the frame-settings screen; "API key
                          for frames" reads wrong next to a browser preview. */}
                      <span className="text-xs">{field.label.replace(/ for frames$/, '')}</span>
                      <TextInput
                        autoComplete="off"
                        type={field.secret ? 'password' : 'text'}
                        value={settingsForm[formKey] ?? ''}
                        onChange={(value) => setSettingsForm((form) => ({ ...form, [formKey]: value }))}
                      />
                    </label>
                  )
                })}
              </div>
            )
          })}
          <Button size="small" color="secondary" onClick={applySettings}>
            Apply keys &amp; restart preview
          </Button>
        </div>
      ) : null}

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button size="small" color="secondary" onClick={forcePreviewRender}>
          Re-render
        </Button>
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
            onClick={() => dispatchPreviewEvent('button', { pin: button.pin, label: button.label, level: 0 })}
          >
            <CursorArrowRaysIcon className="h-4 w-4" />
            {button.label || `GPIO ${button.pin}`}
          </Button>
        ))}
        <span className="frameos-muted ml-auto flex items-center gap-1.5 text-xs">
          {renderCount > 0 ? (
            <>
              {renderCount} render{renderCount === 1 ? '' : 's'}
              {lastRenderMs !== null ? `, last ${lastRenderMs} ms` : ''}
            </>
          ) : null}
          <Tooltip
            title="Runs the scene with the FrameOS interpreter compiled to WebAssembly, in your browser. Device-only
            apps (screenshots, camera snapshots) are unavailable, and apps that fetch external data may be limited by
            browser CORS rules."
          />
        </span>
      </div>

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
        </div>
        {stateEntries.length > 0 ? (
          <div className="max-h-40 overflow-y-auto rounded-lg border border-white/10 bg-slate-900 p-2 font-mono text-xs">
            {visibleStateEntries.length > 0 ? (
              visibleStateEntries.map(([key, value]) => (
                <div key={key} className="break-all">
                  <span className="text-slate-400">{key}</span>
                  <span className="text-slate-500">: </span>
                  <span className="text-slate-100">{typeof value === 'string' ? value : JSON.stringify(value)}</span>
                </div>
              ))
            ) : (
              <div className="text-slate-500">No state fields selected</div>
            )}
          </div>
        ) : null}
      </div>

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
              <div key={index} className="flex gap-3">
                <div className="shrink-0 whitespace-nowrap text-slate-500">{formatTimestamp(log.timestamp)}</div>
                <div
                  className={clsx('min-w-0 flex-1 break-words', logLineColor(log.line))}
                  style={{ wordBreak: 'break-word' }}
                >
                  {renderLogLine(log.line)}
                </div>
              </div>
            ))
          ) : (
            <div className="flex h-full items-center justify-center text-slate-500">No logs yet</div>
          )}
        </div>
      </div>

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
    </div>
  )
}

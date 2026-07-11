import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import { useEffect, useState } from 'react'

import { frameEditorsLogic } from '../scenes/frame/frameEditorsLogic'
import { Diagram } from '../scenes/frame/panels/Diagram/Diagram'
import { EditApp } from '../scenes/frame/panels/EditApp/EditApp'
import { FrameScene } from '../types'
import { embedBridge, embedFrameLogic } from './embedFrameLogic'
// Note: via the build alias this resolves to embedFrameLogic too; imported
// under its public name so BindLogic wires the same instance the Diagram
// dependency graph connects to.
import { frameLogic } from '../scenes/frame/frameLogic'

const EMBED_FRAME_ID = 1

// The postMessage protocol (all messages are objects with a `type`):
//   parent -> editor:
//     {type: 'frameos-editor:init', scenes, sceneId?, mode?, width?, height?, interval?}
//     {type: 'frameos-editor:get-scenes'}          -> replies with :scenes
//     {type: 'frameos-editor:select-scene', sceneId}
//   editor -> parent:
//     {type: 'frameos-editor:ready'}               once listening
//     {type: 'frameos-editor:scenes', scenes}      after every edit (debounced)
//                                                  and as the :get-scenes reply
export function EmbeddedEditor(): JSX.Element {
  const logicProps = { frameId: EMBED_FRAME_ID }
  const logic = useMountedLogic(embedFrameLogic(logicProps))
  const { initEmbedFrame } = useActions(embedFrameLogic(logicProps))
  const { scenes } = useValues(embedFrameLogic(logicProps))
  const [initialized, setInitialized] = useState(false)
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null)

  useEffect(() => {
    embedBridge.onScenesChanged = (nextScenes: FrameScene[]) => {
      window.parent?.postMessage({ type: 'frameos-editor:scenes', scenes: nextScenes }, '*')
    }

    const onMessage = (event: MessageEvent): void => {
      const message = event.data
      if (!message || typeof message !== 'object') {
        return
      }
      if (message.type === 'frameos-editor:init' && Array.isArray(message.scenes)) {
        initEmbedFrame({
          id: EMBED_FRAME_ID,
          scenes: message.scenes,
          mode: message.mode || 'rpios',
          width: message.width || 800,
          height: message.height || 480,
          interval: message.interval ?? 300,
          rotate: 0,
        } as any)
        setSelectedSceneId(
          message.sceneId ??
            (message.scenes.find((scene: FrameScene) => scene.default) || message.scenes[0])?.id ??
            null
        )
        setInitialized(true)
      } else if (message.type === 'frameos-editor:get-scenes') {
        window.parent?.postMessage(
          { type: 'frameos-editor:scenes', scenes: logic.values.frameForm?.scenes ?? [] },
          '*'
        )
      } else if (message.type === 'frameos-editor:select-scene' && typeof message.sceneId === 'string') {
        setSelectedSceneId(message.sceneId)
      }
    }
    window.addEventListener('message', onMessage)
    window.parent?.postMessage({ type: 'frameos-editor:ready' }, '*')
    return () => {
      window.removeEventListener('message', onMessage)
      embedBridge.onScenesChanged = undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!initialized) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-slate-400">
        Waiting for scenes… (post a {'{type: "frameos-editor:init", scenes: [...]}'} message)
      </div>
    )
  }

  return (
    <BindLogic logic={frameLogic} props={logicProps}>
      <BindLogic logic={frameEditorsLogic} props={logicProps}>
        <EmbeddedEditorBody selectedSceneId={selectedSceneId} setSelectedSceneId={setSelectedSceneId} scenes={scenes} />
      </BindLogic>
    </BindLogic>
  )
}

function EmbeddedEditorBody({
  selectedSceneId,
  setSelectedSceneId,
  scenes,
}: {
  selectedSceneId: string | null
  setSelectedSceneId: (sceneId: string) => void
  scenes: FrameScene[]
}): JSX.Element {
  const { activeEditor } = useValues(frameEditorsLogic({ frameId: EMBED_FRAME_ID }))
  const { closeEditor } = useActions(frameEditorsLogic({ frameId: EMBED_FRAME_ID }))
  const appEditorOpen = activeEditor?.kind === 'editApp'

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-white text-slate-900">
      {scenes.length > 1 ? (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-200 px-2 py-1">
          {scenes.map((scene) => (
            <button
              key={scene.id}
              type="button"
              onClick={() => setSelectedSceneId(scene.id)}
              className={
                scene.id === selectedSceneId
                  ? 'rounded bg-slate-200 px-3 py-1 text-sm font-semibold'
                  : 'rounded px-3 py-1 text-sm text-slate-500 hover:bg-slate-100'
              }
            >
              {scene.name || scene.id}
            </button>
          ))}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {selectedSceneId ? <Diagram sceneId={selectedSceneId} showToolbar={false} /> : null}
        {appEditorOpen && activeEditor ? (
          <div className="absolute inset-0 z-20 flex flex-col bg-white">
            <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2">
              <div className="text-sm font-semibold">{activeEditor.title || 'Edit app source'}</div>
              <button
                type="button"
                className="rounded px-3 py-1 text-sm text-slate-500 hover:bg-slate-100"
                onClick={() => closeEditor(activeEditor.key)}
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <EditApp
                editorKey={activeEditor.key}
                sceneId={activeEditor.sceneId}
                nodeId={activeEditor.nodeId ?? ''}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

import { useEffect } from 'react'
import { useActions, useValues } from 'kea'
import { router } from 'kea-router'
import { expandedSceneLogic } from './expandedSceneLogic'
import { Form } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { Button } from '../../../../components/Button'
import { controlLogic } from './controlLogic'
import { frameEditorsLogic } from '../../frameEditorsLogic'
import { StateFieldEdit } from './StateFieldEdit'
import { FrameScene } from '../../../../types'
import { scenesLogic } from './scenesLogic'
import { frameLogic } from '../../frameLogic'
import { apiFetch } from '../../../../utils/apiFetch'
import { longRunningTasksModel } from '../../../../models/longRunningTasksModel'
import { PlayIcon, EyeIcon } from '@heroicons/react/24/solid'
import { WindowIcon } from '@heroicons/react/24/outline'
import { isInFrameAdminMode } from '../../../../utils/frameAdmin'
import { livePreviewLogic, LIVE_PREVIEW_HASH_KEY } from './livePreviewLogic'
import { LivePreviewModal } from './LivePreviewModal'
import { SceneActionsButton, SceneActionOption } from './SceneActionsButton'
import { SceneActionKey } from './sceneActionsLogic'

export interface ExpandedSceneProps {
  sceneId: string
  frameId: number
  scene?: FrameScene | null
  showEditButton?: boolean
  isUnsaved?: boolean
  isUndeployed?: boolean
}

export function ExpandedScene({
  frameId,
  sceneId,
  scene,
  showEditButton = true,
  isUnsaved,
  isUndeployed,
}: ExpandedSceneProps) {
  const { stateChanges, visibleFields } = useValues(expandedSceneLogic({ frameId, sceneId, scene }))
  const { states, sceneId: currentSceneId } = useValues(controlLogic({ frameId }))
  const { requiresRecompilation, changedScenes } = useValues(frameLogic({ frameId }))
  const { undeployedSceneIds } = useValues(scenesLogic({ frameId }))
  const { submitStateChanges, resetStateChanges } = useActions(expandedSceneLogic({ frameId, sceneId, scene }))
  const { previewScene, deleteScene } = useActions(scenesLogic({ frameId }))
  const { openLivePreview } = useActions(livePreviewLogic({ frameId }))
  const { livePreviewSceneId } = useValues(livePreviewLogic({ frameId }))
  const { editScene } = useActions(frameEditorsLogic)
  const fieldCount = visibleFields.length
  const frameAdminMode = isInFrameAdminMode()

  // Reopen the in-browser preview after a reload: openLivePreview stores the
  // scene id in the URL hash, and by the time this card is mounted the frame's
  // scenes are guaranteed to be loaded.
  useEffect(() => {
    if (router.values.hashParams[LIVE_PREVIEW_HASH_KEY] === sceneId && livePreviewSceneId !== sceneId) {
      openLivePreview(sceneId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const currentState = states[sceneId] ?? {}
  const sceneIsUndeployed = isUndeployed ?? undeployedSceneIds.has(sceneId)
  const sceneIsUnsaved = isUnsaved ?? changedScenes.has(sceneId)
  const sceneHasChanges = sceneIsUnsaved || sceneIsUndeployed
  const canPreviewUnsavedChanges = sceneHasChanges && !frameAdminMode
  const activateLabel =
    frameAdminMode && sceneHasChanges
      ? 'Save & activate scene'
      : sceneIsUndeployed && sceneId !== currentSceneId
      ? 'Save changes & redeploy'
      : sceneId === currentSceneId
      ? 'Update active scene'
      : 'Activate scene'

  const buildNextState = (): Record<string, any> => {
    const desiredState = { ...currentState, ...stateChanges }
    const state: Record<string, any> = {}
    for (const field of visibleFields) {
      if (!field.name) {
        continue
      }
      const value = desiredState[field.name] ?? field.value
      if (value !== undefined && value !== null) {
        state[field.name] = String(value)
      }
    }
    return state
  }

  const handlePreview = () => {
    previewScene(sceneId, buildNextState())
  }

  const handleActivate = async () => {
    if (frameAdminMode) {
      if (sceneIsUnsaved) {
        await frameLogic({ frameId }).asyncActions.saveFrame()
      }
      previewScene(sceneId, buildNextState())
      return
    }

    if (sceneHasChanges) {
      longRunningTasksModel.actions.startTask({
        frameId,
        kind: 'deploy',
        sceneId,
        title: requiresRecompilation ? 'Deploying scene changes' : 'Fast deploying scene changes',
        detail: scene?.name || sceneId,
      })
      try {
        await frameLogic({ frameId }).asyncActions.saveFrame()
        const response = await apiFetch(`/api/frames/${frameId}/set_next_scene`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sceneId,
            state: buildNextState(),
            fastDeploy: !requiresRecompilation,
          }),
        })
        if (!response.ok) {
          throw new Error('Failed to queue scene deploy')
        }
      } catch (error) {
        longRunningTasksModel.actions.taskFailed({
          frameId,
          kind: 'deploy',
          sceneId,
          detail: error instanceof Error ? error.message : 'Failed to deploy scene changes',
        })
        throw error
      }
    } else {
      submitStateChanges()
    }
  }

  const handleDelete = () => {
    if (window.confirm('Are you sure you want to delete this scene?')) {
      deleteScene(sceneId)
    }
  }

  const actionOptions: SceneActionOption[] = [
    {
      key: 'activate',
      label: activateLabel,
      description: sceneHasChanges
        ? 'Save your changes, deploy them and make this the active scene'
        : 'Make this the active scene on the frame',
      icon: <PlayIcon className="h-4 w-4 shrink-0" />,
      onRun: () => void handleActivate(),
    },
    {
      key: 'preview-frame',
      label: 'Preview on frame',
      description: 'Temporarily show this scene on the frame, without saving or deploying',
      icon: <EyeIcon className="h-4 w-4 shrink-0" />,
      onRun: handlePreview,
    },
    {
      key: 'preview-browser',
      label: 'Preview in browser',
      description: 'Run this scene in your browser via WebAssembly',
      icon: <WindowIcon className="h-4 w-4 shrink-0" />,
      onRun: () => openLivePreview(sceneId, buildNextState()),
    },
  ]
  // Matches the old standalone buttons: with unsaved/undeployed changes the
  // primary action was the on-frame preview, otherwise activate.
  const defaultActionKey: SceneActionKey = canPreviewUnsavedChanges ? 'preview-frame' : 'activate'

  return (
    <div className="space-y-3">
      {showEditButton ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button onClick={() => editScene(sceneId)} color="secondary">
            Open editor
          </Button>
          <Button onClick={handleDelete} color="red">
            Delete
          </Button>
        </div>
      ) : null}
      {fieldCount === 0 ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <SceneActionsButton options={actionOptions} defaultKey={defaultActionKey} />
          </div>
        </div>
      ) : (
        <Form
          logic={expandedSceneLogic}
          props={{ frameId, sceneId }}
          formKey="stateChanges"
          className="space-y-2 @container"
        >
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
                />
              )}
            </Field>
          ))}
          {fieldCount > 0 ? (
            <div className="flex w-full items-center gap-2">
              <div className="@md:w-1/3 hidden @md:block" />
              <div className="flex w-full flex-wrap items-center gap-2">
                <SceneActionsButton options={actionOptions} defaultKey={defaultActionKey} />
                <Button onClick={() => resetStateChanges()} color="secondary">
                  Reset
                </Button>
              </div>
            </div>
          ) : null}
        </Form>
      )}
      {livePreviewSceneId === sceneId ? <LivePreviewModal frameId={frameId} /> : null}
    </div>
  )
}

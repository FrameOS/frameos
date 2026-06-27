import { useActions, useValues } from 'kea'
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
import { PlayIcon } from '@heroicons/react/24/solid'
import { isInFrameAdminMode } from '../../../../utils/frameAdmin'

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
  const { stateChanges, hasStateChanges, fields } = useValues(expandedSceneLogic({ frameId, sceneId, scene }))
  const { states, sceneId: currentSceneId } = useValues(controlLogic({ frameId }))
  const { requiresRecompilation, changedScenes } = useValues(frameLogic({ frameId }))
  const { undeployedSceneIds } = useValues(scenesLogic({ frameId }))
  const { submitStateChanges, resetStateChanges } = useActions(expandedSceneLogic({ frameId, sceneId, scene }))
  const { previewScene, deleteScene } = useActions(scenesLogic({ frameId }))
  const { editScene } = useActions(frameEditorsLogic)
  const fieldCount = fields.length
  const frameAdminMode = isInFrameAdminMode()

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
  const previewLabel = 'Preview scene with changes'

  const buildNextState = (): Record<string, any> => {
    const desiredState = { ...currentState, ...stateChanges }
    const state: Record<string, any> = {}
    for (const field of fields) {
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
            {canPreviewUnsavedChanges ? (
              <Button onClick={handlePreview} color="primary">
                {previewLabel}
              </Button>
            ) : (
              <Button
                onClick={handleActivate}
                color={sceneId !== currentSceneId && !canPreviewUnsavedChanges ? 'primary' : 'secondary'}
                className="inline-flex items-center gap-2"
              >
                <PlayIcon className="h-5 w-5" />
                {activateLabel}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <Form
          logic={expandedSceneLogic}
          props={{ frameId, sceneId }}
          formKey="stateChanges"
          className="space-y-2 @container"
        >
          {fields.map((field) => (
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
              <div className="flex w-full items-center gap-2">
                {canPreviewUnsavedChanges ? (
                  <Button onClick={handlePreview} color="primary">
                    {previewLabel}
                  </Button>
                ) : (
                  <Button
                    onClick={handleActivate}
                    color={sceneId !== currentSceneId || hasStateChanges ? 'primary' : 'secondary'}
                    className="inline-flex items-center gap-2"
                  >
                    <PlayIcon className="h-5 w-5" />
                    {activateLabel}
                  </Button>
                )}
                <Button onClick={() => resetStateChanges()} color="secondary">
                  Reset
                </Button>
              </div>
            </div>
          ) : null}
        </Form>
      )}
    </div>
  )
}

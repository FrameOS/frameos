import { useActions, useValues } from 'kea'
import { expandedSceneLogic } from './expandedSceneLogic'
import { Form } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { Button } from '../../../../components/Button'
import { controlLogic } from './controlLogic'
import { panelsLogic } from '../panelsLogic'
import { StateFieldEdit } from './StateFieldEdit'
import { FrameScene } from '../../../../types'
import { scenesLogic } from './scenesLogic'
import { frameLogic } from '../../frameLogic'
import { apiFetch } from '../../../../utils/apiFetch'

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
  const { requiresRecompilation, unsavedChanges } = useValues(frameLogic({ frameId }))
  const { submitStateChanges, resetStateChanges } = useActions(expandedSceneLogic({ frameId, sceneId, scene }))
  const { previewScene } = useActions(scenesLogic({ frameId }))
  const { editScene } = useActions(panelsLogic)
  const fieldCount = fields.length ?? 0

  const currentState = states[sceneId] ?? {}
  const canPreviewUnsavedChanges = unsavedChanges || isUndeployed
  const activateLabel =
    isUndeployed && sceneId !== currentSceneId
      ? 'Save changes & redeploy'
      : sceneId === currentSceneId
      ? 'Update active scene'
      : 'Activate scene'

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
    if (unsavedChanges || isUndeployed) {
      await frameLogic({ frameId }).asyncActions.saveFrame()
      await apiFetch(`/api/frames/${frameId}/set_next_scene`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sceneId,
          state: buildNextState(),
          fastDeploy: !requiresRecompilation,
        }),
      })
    } else {
      submitStateChanges()
    }
  }

  return (
    <div className="py-2">
      {fieldCount === 0 ? (
        <div className="space-y-2">
          <div>This scene does not export publicly controllable state.</div>
          <div className="flex items-center gap-2">
            {canPreviewUnsavedChanges ? (
              <Button onClick={handlePreview} color="primary">
                Preview {isUnsaved ? 'unsaved' : isUndeployed ? 'undeployed' : ''} scene
              </Button>
            ) : (
              <Button
                onClick={handleActivate}
                color={sceneId !== currentSceneId && !canPreviewUnsavedChanges ? 'primary' : 'secondary'}
              >
                {activateLabel}
              </Button>
            )}
            {showEditButton ? (
              <Button onClick={() => editScene(sceneId)} color="secondary">
                Edit scene
              </Button>
            ) : null}
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
                    Preview {isUnsaved ? 'unsaved' : isUndeployed ? 'undeployed' : ''} scene
                  </Button>
                ) : (
                  <Button
                    onClick={handleActivate}
                    color={sceneId !== currentSceneId || hasStateChanges ? 'primary' : 'secondary'}
                  >
                    {activateLabel}
                  </Button>
                )}
                <Button onClick={() => resetStateChanges()} color="secondary">
                  Reset
                </Button>
                {showEditButton ? (
                  <Button onClick={() => editScene(sceneId)} color="secondary">
                    Edit scene
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </Form>
      )}
    </div>
  )
}

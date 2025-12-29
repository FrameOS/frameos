import { useActions, useValues } from 'kea'
import { expandedSceneLogic } from './expandedSceneLogic'
import { Form } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { Button } from '../../../../components/Button'
import { controlLogic } from './controlLogic'
import { panelsLogic } from '../panelsLogic'
import { StateFieldEdit } from './StateFieldEdit'
import { FrameScene } from '../../../../types'

export interface ExpandedSceneProps {
  sceneId: string
  frameId: number
  scene?: FrameScene | null
  showEditButton?: boolean
}

export function ExpandedScene({ frameId, sceneId, scene, showEditButton = true }: ExpandedSceneProps) {
  const { stateChanges, hasStateChanges, fields } = useValues(expandedSceneLogic({ frameId, sceneId, scene }))
  const { states, sceneId: currentSceneId } = useValues(controlLogic({ frameId }))
  const { submitStateChanges, resetStateChanges } = useActions(expandedSceneLogic({ frameId, sceneId, scene }))
  const { editScene } = useActions(panelsLogic)
  const fieldCount = fields.length ?? 0

  const currentState = states[sceneId] ?? {}

  return (
    <div className="py-2">
      {fieldCount === 0 ? (
        <div className="space-y-2">
          <div>This scene does not export publicly controllable state.</div>
          <div className="flex items-center gap-2">
            <Button onClick={submitStateChanges} color={sceneId !== currentSceneId ? 'primary' : 'secondary'}>
              Activate scene
            </Button>
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
                <Button
                  onClick={submitStateChanges}
                  color={sceneId !== currentSceneId || hasStateChanges ? 'primary' : 'secondary'}
                >
                  {sceneId === currentSceneId ? 'Update active scene' : 'Activate scene'}
                </Button>
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

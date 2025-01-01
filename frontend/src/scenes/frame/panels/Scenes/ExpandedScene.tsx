import { useActions, useValues } from 'kea'
import { expandedSceneLogic } from './expandedSceneLogic'
import { Form } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { Select } from '../../../../components/Select'
import { TextArea } from '../../../../components/TextArea'
import { TextInput } from '../../../../components/TextInput'
import { Button } from '../../../../components/Button'
import { controlLogic } from './controlLogic'

export interface ExpandedSceneProps {
  sceneId: string
  frameId: number
}

export function ExpandedScene({ frameId, sceneId }: ExpandedSceneProps) {
  const { stateChanges, hasStateChanges, fields } = useValues(expandedSceneLogic({ frameId, sceneId }))
  const { states, sceneId: currentSceneId } = useValues(controlLogic({ frameId }))
  const { submitStateChanges, resetStateChanges } = useActions(expandedSceneLogic({ frameId, sceneId }))
  const fieldCount = fields.length ?? 0

  const currentState = states[sceneId] ?? {}

  return (
    <div className="py-2">
      {fieldCount === 0 ? (
        <div className="space-y-2">
          <div>This scene does not export publicly controllable state. Use the "State" panel to configure.</div>
          <Button onClick={submitStateChanges} color={sceneId !== currentSceneId ? 'primary' : 'secondary'}>
            Activate scene
          </Button>
        </div>
      ) : (
        <Form logic={expandedSceneLogic} props={{ frameId, sceneId }} formKey="stateChanges" className="space-y-2">
          {fields.map((field) => (
            <div key={field.name} className="bg-gray-900 space-y-1">
              <div>
                {field.label || field.name}
                {field.name in stateChanges && stateChanges[field.name] !== (currentState[field.name] ?? field.value)
                  ? ' (modified)'
                  : ''}
              </div>
              <div>
                {field.type === 'select' ? (
                  <Field name={field.name}>
                    {({ value, onChange }) => (
                      <Select
                        placeholder={field.placeholder}
                        value={stateChanges[field.name] ?? currentState[field.name] ?? value ?? field.value}
                        onChange={onChange}
                        options={(field.options ?? []).map((option) => ({ label: option, value: option }))}
                      />
                    )}
                  </Field>
                ) : field.type === 'boolean' ? (
                  <Field name={field.name}>
                    {({ value, onChange }) => (
                      <Select
                        placeholder={field.placeholder}
                        value={stateChanges[field.name] ?? currentState[field.name] ?? value ?? field.value}
                        onChange={onChange}
                        options={['true', 'false'].map((option) => ({ label: option, value: option }))}
                      />
                    )}
                  </Field>
                ) : field.type === 'text' ? (
                  <Field name={field.name}>
                    {({ value, onChange }) => (
                      <TextArea
                        placeholder={field.placeholder}
                        value={stateChanges[field.name] ?? currentState[field.name] ?? value ?? field.value}
                        onChange={onChange}
                        rows={3}
                      />
                    )}
                  </Field>
                ) : (
                  <Field name={field.name}>
                    {({ value, onChange }) => (
                      <TextInput
                        placeholder={field.placeholder}
                        value={stateChanges[field.name] ?? currentState[field.name] ?? value ?? field.value}
                        onChange={onChange}
                      />
                    )}
                  </Field>
                )}
              </div>
              <div className="flex items-center gap-1"></div>
            </div>
          ))}
          {fieldCount > 0 ? (
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
            </div>
          ) : null}
        </Form>
      )}
    </div>
  )
}

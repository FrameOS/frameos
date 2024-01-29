import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { sceneFormLogic } from './sceneFormLogic'
import { Form, Group } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { TextInput } from '../../../../components/TextInput'
import { Select } from '../../../../components/Select'
import { configFieldTypes } from '../../../../types'
import { Button } from '../../../../components/Button'

export function SceneForm({ sceneId }: { sceneId: string }): JSX.Element | null {
  const { frameId } = useValues(frameLogic)
  const { sceneForm } = useValues(sceneFormLogic({ frameId, sceneId }))
  const { setSceneFormValue } = useActions(sceneFormLogic({ frameId, sceneId }))

  if (!sceneForm) {
    return null
  }

  return (
    <Form logic={sceneFormLogic} props={{ frameId, sceneId }} formKey="sceneForm" className="space-y-4">
      <Group name={[]}>
        <div className="bg-gray-900 p-2 space-y-2">
          <Field name="id" label="Scene ID (change at your own risk)">
            <TextInput />
          </Field>
          <Field name="name" label="Name">
            <TextInput />
          </Field>
        </div>
        <div className="flex justify-between w-full items-center gap-2">
          <div className="font-bold">Fields</div>
          <Button
            onClick={() => {
              setSceneFormValue('fields', [...(sceneForm.fields ?? []), { name: '', label: '', type: 'string' }])
            }}
            size="small"
          >
            Add field
          </Button>
        </div>
        {sceneForm.fields?.map((field, index) => (
          <Group name={['fields', index]}>
            <div className="bg-gray-900 p-2 space-y-2">
              <div className="flex justify-between items-center w-full gap-2">
                <div>Field #{index + 1}</div>
                <Button
                  onClick={() => {
                    setSceneFormValue(
                      'fields',
                      (sceneForm.fields ?? []).map((f, i) => (i === index ? undefined : f)).filter(Boolean)
                    )
                  }}
                  size="small"
                >
                  Remove field
                </Button>
              </div>
              <Field name="type" label="Type of field">
                <Select options={configFieldTypes.filter((f) => f !== 'node').map((k) => ({ label: k, value: k }))} />
              </Field>
              <Field name="name" label="Name (keyword in code)">
                <TextInput />
              </Field>
              <Field name="label" label="Label (for user entry)">
                <TextInput />
              </Field>
              <Field name="value" label="Initial value">
                <TextInput />
              </Field>
              <Field name="placeholder" label="Placeholder">
                <TextInput />
              </Field>
            </div>
          </Group>
        ))}
      </Group>
    </Form>
  )
}

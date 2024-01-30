import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { sceneConfigLogic } from './sceneConfigLogic'
import { Form, Group } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { TextInput } from '../../../../components/TextInput'
import { Select } from '../../../../components/Select'
import { configFieldTypes } from '../../../../types'
import { Button } from '../../../../components/Button'
import { Tooltip } from '../../../../components/Tooltip'

const PERSIST_OPTIONS = [
  { label: 'memory (reset on boot)', value: 'memory' },
  { label: 'disk (or sd card)', value: 'disk' },
]

export function SceneConfig(): JSX.Element {
  const sceneId = 'default'
  const { frameId } = useValues(frameLogic)
  const { sceneForm } = useValues(sceneConfigLogic({ frameId, sceneId }))
  const { setSceneFormValue } = useActions(sceneConfigLogic({ frameId, sceneId }))

  if (!sceneForm) {
    return <></>
  }

  return (
    <Form logic={sceneConfigLogic} props={{ frameId, sceneId }} formKey="sceneForm" className="space-y-4">
      <Group name={[]}>
        <div className="bg-gray-900 p-2 space-y-4">
          <Field name="id" label="Scene ID">
            <TextInput disabled />
          </Field>
        </div>
        <div className="flex justify-between w-full items-center gap-2">
          <div className="flex items-center gap-2">
            <code className="font-bold">sceneConfig</code>
            <Tooltip
              title={
                <>
                  The fields you set here will be available through <code>sceneConfig.fieldName</code> in your app
                </>
              }
            />
          </div>
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
            <div className="bg-gray-900 p-2 space-y-4">
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
              <Field
                name="persist"
                label="Perist"
                tooltip={<>Persisting to disk reduces the lifetime of your SD card</>}
              >
                <Select options={PERSIST_OPTIONS} />
              </Field>
            </div>
          </Group>
        ))}
      </Group>
    </Form>
  )
}

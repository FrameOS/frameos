import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { sceneStateLogic } from './sceneStateLogic'
import { Form, Group } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { TextInput } from '../../../../components/TextInput'
import { Select } from '../../../../components/Select'
import { configFieldTypes } from '../../../../types'
import { Button } from '../../../../components/Button'
import { Tooltip } from '../../../../components/Tooltip'
import { fieldTypeToGetter } from '../../../../utils/fieldTypes'
import { ClipboardDocumentIcon } from '@heroicons/react/24/outline'
import copy from 'copy-to-clipboard'
import { TextArea } from '../../../../components/TextArea'
import { panelsLogic } from '../panelsLogic'
import { H6 } from '../../../../components/H6'
import { camelize } from '../../../../utils/camelize'

const PERSIST_OPTIONS = [
  { label: 'memory (reset on boot)', value: 'memory' },
  { label: 'disk (or sd card)', value: 'disk' },
]

const ACCESS_OPTIONS = [
  { label: 'private (use in the scene)', value: 'private' },
  { label: 'public (controllable externally)', value: 'public' },
]

export function SceneState(): JSX.Element {
  const { frameId } = useValues(frameLogic)
  const { selectedSceneId: sceneId } = useValues(panelsLogic({ frameId }))
  const {
    sceneForm,
    scene,
    isSceneFormSubmitting,
    sceneFormChanged,
    sceneFormHasErrors,
    showSceneFormErrors,
    editingFields,
    fieldsWithErrors,
  } = useValues(sceneStateLogic({ frameId, sceneId }))
  const { setSceneFormValue, resetField, submitField, editField, closeField, removeField } = useActions(
    sceneStateLogic({ frameId, sceneId })
  )

  let fieldCount = (sceneForm.fields ?? []).length

  if (!sceneForm || !sceneId) {
    return <></>
  }

  return (
    <div className="space-y-4">
      <div>
        Fields defined here are accessible in your scene via the <code className="text-xs">{'state'}</code> object.{' '}
        <div className="inline-block align-text-top">
          <Tooltip
            title={
              <div className="space-y-2">
                <div>
                  The state is just Nim's{' '}
                  <a href="https://nim-lang.org/docs/json.html" target="_blank" rel="noreferer">
                    <code className="text-xs underline">JsonNode</code>
                  </a>
                  , so access it accordingly. This means use code like{' '}
                  <code className="text-xs">{'state{"field"}.getStr()'}</code> to access values, and{' '}
                  <pre className="text-xs">{'state{"field"} = %*("str")'}</pre>
                  to store them.
                </div>
                <div>
                  You can also choose which field is persisted to disk to survive reboots, and which is publicly
                  controllable.
                </div>
              </div>
            }
          />
        </div>
      </div>
      <div className="flex justify-between w-full items-center gap-2 mb-2">
        <div className="flex items-center gap-1">
          <H6>Scene "{scene?.name || 'Unnamed Scene'}"</H6>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => {
              const oldFields = sceneForm.fields ?? []
              setSceneFormValue('fields', [...oldFields, { name: '', label: '', type: 'string' }])
              editField(oldFields.length)
            }}
            size="small"
            color="secondary"
          >
            Add field
          </Button>
        </div>
      </div>
      <Form logic={sceneStateLogic} props={{ frameId, sceneId }} formKey="sceneForm" className="space-y-4">
        {sceneForm.fields?.map((field, index) => (
          <Group name={['fields', index]}>
            <div className="flex items-center gap-1 justify-between">
              <div className="flex items-center gap-1">
                <ClipboardDocumentIcon
                  className="w-4 h-4 min-w-4 min-h-4 cursor-pointer inline-block"
                  onClick={() =>
                    copy(`state{"${field.name}"}${fieldTypeToGetter[String(field.type ?? 'string')] ?? '.getStr()'}`)
                  }
                />
                <code className="text-sm text-gray-400 break-words">{`state{"${field.name}"}${
                  fieldTypeToGetter[String(field.type ?? 'string')] ?? '.getStr()'
                }`}</code>
              </div>
              <Button
                onClick={editingFields[index] ? () => closeField(index) : () => editField(index)}
                size="small"
                color={'secondary'}
              >
                {editingFields[index] ? 'Close' : 'Edit'}
              </Button>
            </div>
            {editingFields[index] ? (
              <div className="bg-gray-900 p-2 space-y-4">
                <Field name="label" label="Field label (human readable)">
                  {({ value, onChange }) => (
                    <TextInput
                      placeholder="e.g. Search Term"
                      value={value}
                      onChange={(value) => {
                        if (!field.name || field.name === camelize(field.label)) {
                          setSceneFormValue('fields', [
                            ...(sceneForm.fields ?? []).map((f, i) =>
                              i === index ? { ...f, name: camelize(value), label: value } : f
                            ),
                          ])
                        } else {
                          onChange(value)
                        }
                      }}
                    />
                  )}
                </Field>
                <Field name="name" label="Field name (for use in code)">
                  <TextInput placeholder="e.g. search" />
                </Field>
                <Field name="type" label="Field type">
                  <Select options={configFieldTypes.filter((f) => f !== 'node').map((k) => ({ label: k, value: k }))} />
                </Field>
                {field.type === 'select' ? (
                  <Field name="options" label="Options (one per line)">
                    <TextArea
                      value={(field.options ?? []).join('\n')}
                      rows={3}
                      onChange={(value) =>
                        setSceneFormValue(
                          'fields',
                          (sceneForm.fields ?? []).map((field, i) =>
                            i === index ? { ...field, options: value.split('\n') } : field
                          )
                        )
                      }
                    />
                  </Field>
                ) : null}
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
                <Field
                  name="access"
                  label="Access"
                  tooltip={
                    <>
                      Whether this field is just usable within the scene (private), or if it can also be controlled
                      externally, for example from the frame's settings page.
                    </>
                  }
                >
                  <Select options={ACCESS_OPTIONS} />
                </Field>
                <div className="flex justify-end items-center w-full gap-2">
                  <Button
                    onClick={() => {
                      removeField(index)
                    }}
                    size="small"
                    color="secondary"
                  >
                    <span className="text-red-300">Remove field</span>
                  </Button>
                </div>
                {sceneFormHasErrors && showSceneFormErrors && fieldsWithErrors[field.name] ? (
                  <div className="text-red-400">
                    <p>There are errors in the form. Please fix them before saving.</p>
                  </div>
                ) : null}
                <div className="flex w-full items-center gap-2">
                  <Button
                    onClick={() => submitField(index)}
                    color={sceneFormChanged ? 'primary' : 'secondary'}
                    size="small"
                    disabled={isSceneFormSubmitting || fieldsWithErrors[field.name]}
                  >
                    Save changes
                  </Button>
                  <Button
                    onClick={() => {
                      resetField(index)
                    }}
                    color="secondary"
                    size="small"
                  >
                    Reset
                  </Button>
                  <div>
                    <Tooltip title="Remember, after saving changes here, you must also save the scene for these changes to persist" />
                  </div>
                </div>
              </div>
            ) : null}
          </Group>
        ))}
        {(sceneForm.fields ?? []).length === 0 ? <div>No fields yet. Add one to get started.</div> : null}
      </Form>
    </div>
  )
}

SceneState.PanelTitle = function SceneStatePanelTitle() {
  const { frameId } = useValues(frameLogic)
  const { selectedSceneId: sceneId } = useValues(panelsLogic({ frameId }))
  const { sceneFormChanged } = useValues(sceneStateLogic({ frameId, sceneId }))

  return (
    <>
      {sceneFormChanged ? '* ' : ''}
      Scene State
    </>
  )
}

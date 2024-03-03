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
  const { sceneIndex, scene, editingFields, fieldsWithErrors } = useValues(sceneStateLogic({ frameId, sceneId }))
  const { setFields, editField, closeField, removeField } = useActions(sceneStateLogic({ frameId, sceneId }))

  if (!scene || !sceneId) {
    return <></>
  }

  return (
    <Form logic={frameLogic} props={{ frameId }} formKey="frameForm">
      <Group name={['scenes', sceneIndex]}>
        <div className="space-y-8">
          <div className="w-full mb-2">
            <H6>Scene "{scene?.name || 'Unnamed Scene'}" Settings</H6>
            <div className="w-full space-y-1">
              <Group name={['settings']}>
                <Field
                  className="flex flex-row gap-2 w-full justify-between"
                  name="refreshInterval"
                  label="Refresh interval in seconds"
                  tooltip={
                    <>
                      How often do we trigger a refresh, in seconds. Pass a large number like "60" or even more for
                      e-ink frames. A number below 1 activates realtime mode (0.041s = 24fps, 0.016s = 60fps). This
                      should be used when you're certain of your setup and only if your hardware supports it.
                    </>
                  }
                >
                  <TextInput name="refreshInterval" placeholder="300" style={{ width: 70 }} />
                </Field>
                <Field
                  className="flex flex-row gap-2 w-full justify-between"
                  name="backgroundColor"
                  label="Background color"
                >
                  <TextInput
                    type="color"
                    name="backgroundColor"
                    className="!p-0"
                    style={{ width: 70 }}
                    placeholder="#ffffff"
                  />
                </Field>
              </Group>
            </div>
          </div>
          <div>
            <div className="flex justify-between w-full items-center gap-2 mb-2">
              <H6>
                State Fields{' '}
                <div className="inline-block align-text-top">
                  <Tooltip
                    title={
                      <div className="space-y-2">
                        <div>
                          Fields defined here are accessible in your scene via the{' '}
                          <code className="text-xs">{'state'}</code> object.{' '}
                        </div>
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
              </H6>
              <div>
                <Button
                  onClick={() => {
                    const oldFields = scene?.fields ?? []
                    setFields([...oldFields, { name: '', label: '', type: 'string' }])
                    editField(oldFields.length)
                  }}
                  size="small"
                  color="secondary"
                >
                  Add field
                </Button>
              </div>
            </div>
            <div className="space-y-4">
              {scene?.fields?.map((field, index) => (
                <Group name={['fields', index]}>
                  <div className="flex items-center gap-1 justify-between max-w-full w-full">
                    <div className="flex items-center gap-1 max-w-full w-full overflow-hidden">
                      <ClipboardDocumentIcon
                        className="w-4 h-4 min-w-4 min-h-4 cursor-pointer inline-block"
                        onClick={() =>
                          copy(
                            `state{"${field.name}"}${fieldTypeToGetter[String(field.type ?? 'string')] ?? '.getStr()'}`
                          )
                        }
                      />
                      <code className="text-sm text-gray-400 break-words truncate">{`state{"${field.name}"}${
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
                  {fieldsWithErrors[field.name] ? (
                    <div className="text-red-400">
                      <p>There are errors with this field. Please fix them to save.</p>
                    </div>
                  ) : null}
                  {editingFields[index] ? (
                    <div className="bg-gray-900 p-2 space-y-4">
                      <Field name="label" label="Field label (human readable)">
                        {({ value, onChange }) => (
                          <TextInput
                            placeholder="e.g. Search Term"
                            value={value}
                            onChange={(value) => {
                              if (!field.name || field.name === camelize(field.label)) {
                                setFields([
                                  ...(scene.fields ?? []).map((f, i) =>
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
                        <Select
                          options={configFieldTypes.filter((f) => f !== 'node').map((k) => ({ label: k, value: k }))}
                        />
                      </Field>
                      {field.type === 'select' ? (
                        <Field name="options" label="Options (one per line)">
                          <TextArea
                            value={(field.options ?? []).join('\n')}
                            rows={3}
                            onChange={(value) =>
                              setFields(
                                (scene.fields ?? []).map((field, i) =>
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
                            Whether this field is just usable within the scene (private), or if it can also be
                            controlled externally, for example from the frame's settings page.
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
                      <div className="flex w-full items-center gap-2">
                        <Button
                          onClick={() => {
                            closeField(index)
                          }}
                          color="secondary"
                          size="small"
                        >
                          Close
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </Group>
              ))}
              {(scene.fields ?? []).length === 0 ? <div>No fields yet. Add one to share data between apps.</div> : null}
            </div>
          </div>
        </div>
      </Group>
    </Form>
  )
}

SceneState.PanelTitle = function SceneStatePanelTitle() {
  return <>Scene State</>
}

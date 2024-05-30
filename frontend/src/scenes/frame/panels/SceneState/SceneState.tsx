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
import { stateFieldAccess } from '../../../../utils/fieldTypes'
import { ClipboardDocumentIcon } from '@heroicons/react/24/outline'
import copy from 'copy-to-clipboard'
import { TextArea } from '../../../../components/TextArea'
import { panelsLogic } from '../panelsLogic'
import { H6 } from '../../../../components/H6'
import { camelize } from '../../../../utils/camelize'
import { Tag } from '../../../../components/Tag'

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
  const { selectedStateSceneId: sceneId } = useValues(panelsLogic({ frameId }))
  const { sceneIndex, scene, editingFields, fieldsWithErrors } = useValues(sceneStateLogic({ frameId, sceneId }))
  const { setFields, addField, editField, closeField, removeField } = useActions(sceneStateLogic({ frameId, sceneId }))

  if (!scene || !sceneId) {
    return <div>Add a scene first</div>
  }

  const onDragStart = (event: any, type: 'code', keyword: string) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify({ type, keyword }))
    event.dataTransfer.effectAllowed = 'move'
  }

  return (
    <Form logic={frameLogic} props={{ frameId }} formKey="frameForm">
      <Group name={['scenes', sceneIndex]}>
        <div className="flex justify-between w-full items-center gap-2 mb-2 mt-4">
          <H6>
            State fields{' '}
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
            <Button onClick={() => addField()} size="small" color="secondary">
              Add field
            </Button>
          </div>
        </div>
        <div className="space-y-4">
          {scene?.fields?.map((field, index) => (
            <Group name={['fields', index]} key={index}>
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
                              ...(scene?.fields ?? []).map((f, i) =>
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
                            (scene?.fields ?? []).map((field, i) =>
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
                  <div className="flex w-full items-center justify-between gap-2">
                    <Button
                      onClick={() => {
                        closeField(index)
                      }}
                      color="secondary"
                      size="small"
                    >
                      Save & Close
                    </Button>
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
                </div>
              ) : (
                <div
                  className="bg-gray-900 p-2 dndnode cursor-move"
                  draggable
                  onDragStart={(event) => onDragStart(event, 'code', stateFieldAccess(field, 'state'))}
                >
                  <div className="flex items-center gap-1 justify-between max-w-full w-full">
                    <div className="flex items-center gap-1 max-w-full w-full overflow-hidden">
                      {field.label || field.name || 'Unnamed field'}
                    </div>
                    <Button
                      onClick={editingFields[index] ? () => closeField(index) : () => editField(index)}
                      size="small"
                      color={'secondary'}
                    >
                      {editingFields[index] ? 'Close' : 'Edit'}
                    </Button>
                  </div>
                  <div className="flex items-center gap-1 max-w-full w-full overflow-hidden">
                    <ClipboardDocumentIcon
                      className="w-4 h-4 min-w-4 min-h-4 cursor-pointer inline-block"
                      onClick={() => copy(stateFieldAccess(field))}
                    />
                    <code className="text-sm text-gray-400 break-words truncate">{stateFieldAccess(field)}</code>
                  </div>
                  <div className="flex gap-2 mt-1">
                    <Tooltip
                      title={
                        field.persist === 'disk' ? (
                          <>Changes to this field are persisted and restored after a reboot.</>
                        ) : (
                          <>Changes to this field are kept in memory. The default value is restored after a reboot.</>
                        )
                      }
                    >
                      <Tag color={field.persist === 'disk' ? 'blue' : 'gray'}>{field.persist}</Tag>
                    </Tooltip>
                    <Tooltip
                      title={
                        field.access === 'public' ? (
                          <>This field can be modified with the frame's Control URL.</>
                        ) : (
                          <>
                            This field is not visible to nor controllable from the frame's Control URL. It is only
                            accessible inside the scene.
                          </>
                        )
                      }
                    >
                      <Tag color={field.access === 'private' ? 'gray' : 'blue'}>{field.access}</Tag>
                    </Tooltip>
                  </div>
                </div>
              )}
            </Group>
          ))}
          {(scene.fields ?? []).length === 0 ? <div>No fields yet. Add one to share data between apps.</div> : null}
        </div>
      </Group>
    </Form>
  )
}

SceneState.PanelTitle = function SceneStatePanelTitle() {
  return <>State</>
}

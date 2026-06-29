import { useActions, useValues } from 'kea'
import { useState, DragEvent as ReactDragEvent } from 'react'
import { frameLogic } from '../../frameLogic'
import { sceneStateLogic } from './sceneStateLogic'
import { Form, Group } from 'kea-forms'
import { Button } from '../../../../components/Button'
import { Tooltip } from '../../../../components/Tooltip'
import { stateFieldAccess } from '../../../../utils/fieldTypes'
import { ClipboardDocumentIcon } from '@heroicons/react/24/outline'
import copy from 'copy-to-clipboard'
import { frameEditorsLogic } from '../../frameEditorsLogic'
import { H6 } from '../../../../components/H6'
import { Tag } from '../../../../components/Tag'
import { sceneExecutionForFrame } from '../../../../utils/sceneExecution'
import { FieldDefinitionForm } from '../Fields/FieldDefinitionForm'

function JavaScriptStateHelp({ codeClassName }: { codeClassName?: string }): JSX.Element {
  return (
    <div className="space-y-2">
      <div>
        In inline JavaScript code nodes, read values with <code className={codeClassName}>state.variableName</code>.
      </div>
      <div>
        In JavaScript apps, read from <code className={codeClassName}>app.state.variableName</code> and write shared
        values with <code className={codeClassName}>{"frameos.setState('variableName', value)"}</code>.
      </div>
    </div>
  )
}

export function SceneState({ sceneId: sceneIdOverride }: { sceneId?: string | null } = {}): JSX.Element {
  const { frameId } = useValues(frameLogic)
  const { selectedSceneId } = useValues(frameEditorsLogic({ frameId }))
  const sceneId = sceneIdOverride ?? selectedSceneId
  const { sceneIndex, scene, editingFields, fieldsWithErrors, frameForm } = useValues(
    sceneStateLogic({ frameId, sceneId })
  )
  const { setFields, addField, editField, closeField, removeField } = useActions(sceneStateLogic({ frameId, sceneId }))
  const [draggedField, setDraggedField] = useState<number | null>(null)

  if (!scene || !sceneId) {
    return <div className="frame-tool-muted">Select a scene first.</div>
  }

  const stateFields = scene.fields ?? []
  const publicFieldCount = stateFields.filter((field) => field.access === 'public').length
  const persistedFieldCount = stateFields.filter((field) => field.persist === 'disk').length
  const isInterpreted = sceneExecutionForFrame(scene, frameForm?.mode) === 'interpreted'

  const onDragStart = (event: any, type: 'state', keyword: string, index: number) => {
    setDraggedField(index)
    event.dataTransfer.setData('application/reactflow', JSON.stringify({ type, keyword }))
    event.dataTransfer.effectAllowed = 'move'
  }

  const onDropField = (event: ReactDragEvent, index: number) => {
    event.preventDefault()
    if (draggedField === null || draggedField === index) {
      return
    }
    const fields = [...(scene?.fields ?? [])]
    const [removed] = fields.splice(draggedField, 1)
    fields.splice(index, 0, removed)
    setFields(fields)
    setDraggedField(null)
  }

  const onDragOverField = (event: ReactDragEvent) => {
    event.preventDefault()
  }

  return (
    <Form logic={frameLogic} props={{ frameId }} formKey="frameForm">
      <Group name={['scenes', sceneIndex]}>
        <div className="frame-tool-panel space-y-4">
          <div className="frame-tool-card rounded-2xl p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">State variables</div>
                <H6 className="mt-1 flex items-center gap-2">
                  <span className="truncate">Scene state</span>
                  <Tooltip
                    title={
                      <div className="space-y-2">
                        <div>
                          Fields defined here are accessible in your scene via the{' '}
                          <code className="text-xs">{'state'}</code> object.
                        </div>
                        {isInterpreted ? (
                          <JavaScriptStateHelp codeClassName="text-xs" />
                        ) : (
                          <div>
                            The state is Nim's{' '}
                            <a href="https://nim-lang.org/docs/json.html" target="_blank" rel="noreferer">
                              <code className="text-xs underline">JsonNode</code>
                            </a>
                            . Use <code className="text-xs">{'state{"field"}.getStr()'}</code> to read values and{' '}
                            <pre className="text-xs">{'state{"field"} = %*("str")'}</pre> to store them.
                          </div>
                        )}
                      </div>
                    }
                  />
                </H6>
              </div>
              <Button onClick={() => addField()} size="small" color="secondary">
                Add variable
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="frame-tool-row rounded-xl px-3 py-2">
              <div className="frame-tool-muted text-[11px] font-semibold uppercase tracking-wide">Total</div>
              <div className="text-lg font-bold">{stateFields.length}</div>
            </div>
            <div className="frame-tool-row rounded-xl px-3 py-2">
              <div className="frame-tool-muted text-[11px] font-semibold uppercase tracking-wide">Public</div>
              <div className="text-lg font-bold">{publicFieldCount}</div>
            </div>
            <div className="frame-tool-row rounded-xl px-3 py-2">
              <div className="frame-tool-muted text-[11px] font-semibold uppercase tracking-wide">Persisted</div>
              <div className="text-lg font-bold">{persistedFieldCount}</div>
            </div>
          </div>
          <div className="space-y-3">
            {scene?.fields?.map((field, index) => (
              <Group name={['fields', index]} key={index}>
                {fieldsWithErrors[index] ? (
                  <div className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-400">
                    <p>There are errors with this field. Please fix them to save.</p>
                  </div>
                ) : null}
                {editingFields[index] ? (
                  <FieldDefinitionForm
                    field={field}
                    fields={scene?.fields ?? []}
                    index={index}
                    setFields={setFields}
                    closeField={closeField}
                    removeField={removeField}
                    includeStateOptions
                  />
                ) : (
                  <div
                    className="frame-tool-row frameos-primary-hover-border dndnode cursor-move rounded-2xl p-3 transition"
                    draggable
                    onDragStart={(event) => onDragStart(event, 'state', field.name, index)}
                    onDragOver={onDragOverField}
                    onDrop={(event) => onDropField(event, index)}
                    onDragEnd={() => setDraggedField(null)}
                  >
                    <div className="flex items-center gap-1 justify-between max-w-full w-full">
                      <div className="flex items-center gap-1 max-w-full w-full overflow-hidden">
                        {field.label || field.name || 'Unnamed field'}
                      </div>
                      <div className="flex gap-1">
                        <Tooltip
                          title={
                            field.persist === 'disk' ? (
                              <>Changes to this field are persisted and restored after a reboot.</>
                            ) : (
                              <>
                                Changes to this field are kept in memory. The default value is restored after a reboot.
                              </>
                            )
                          }
                        >
                          <Tag color={field.persist === 'disk' ? 'blue' : 'gray'}>{field.persist}</Tag>
                        </Tooltip>
                        <Tooltip
                          title={
                            field.access === 'public' ? (
                              <>This field can be set externally.</>
                            ) : (
                              <>
                                This field is not visible to nor controllable from anywhere. It is only accessible
                                inside the scene.
                              </>
                            )
                          }
                        >
                          <Tag color={field.access === 'private' ? 'gray' : 'blue'}>{field.access}</Tag>
                        </Tooltip>
                        <Button
                          onClick={editingFields[index] ? () => closeField(index) : () => editField(index)}
                          size="small"
                          color={'secondary'}
                        >
                          {editingFields[index] ? 'Close' : 'Edit'}
                        </Button>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 max-w-full w-full overflow-hidden">
                      <ClipboardDocumentIcon
                        className="w-4 h-4 min-w-4 min-h-4 cursor-pointer inline-block"
                        onClick={() => copy(stateFieldAccess(scene, field, 'state', frameForm?.mode))}
                      />
                      <code className="frame-tool-muted text-sm break-words truncate">
                        {stateFieldAccess(scene, field, 'state', frameForm?.mode)}
                      </code>
                    </div>
                  </div>
                )}
              </Group>
            ))}
            {(scene.fields ?? []).length === 0 ? (
              <div className="frame-tool-card rounded-2xl p-4 frame-tool-muted">
                {isInterpreted ? (
                  <JavaScriptStateHelp />
                ) : (
                  <>
                    Use the <code>state</code> object of type{' '}
                    <a href="https://nim-lang.org/docs/json.html" className="underline" target="_blank" rel="noreferer">
                      <code>JsonNode</code>
                    </a>{' '}
                    to share data between nodes.
                  </>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </Group>
    </Form>
  )
}

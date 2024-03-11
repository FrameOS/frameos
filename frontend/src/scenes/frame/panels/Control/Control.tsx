import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { controlLogic } from './controlLogic'
import { Form, Group } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { TextInput } from '../../../../components/TextInput'
import { Select } from '../../../../components/Select'
import { Button } from '../../../../components/Button'
import { Tooltip } from '../../../../components/Tooltip'
import { fieldTypeToGetter } from '../../../../utils/fieldTypes'
import { ClipboardDocumentIcon } from '@heroicons/react/24/outline'
import copy from 'copy-to-clipboard'
import { Spinner } from '../../../../components/Spinner'
import { TextArea } from '../../../../components/TextArea'
import { H6 } from '../../../../components/H6'
import { Tag } from '../../../../components/Tag'

export function Control(): JSX.Element {
  const { frameId } = useValues(frameLogic)
  const {
    scene,
    currentSceneId,
    selectedSceneId,
    stateChanges,
    stateRecordsLoading,
    loading,
    state,
    stateChangesChanged,
    scenesAsOptions,
    fields,
  } = useValues(controlLogic({ frameId }))
  const { setSelectedSceneId, sync, submitStateChanges, resetStateChanges } = useActions(controlLogic({ frameId }))
  const fieldCount = fields.length ?? 0

  const buttons = (
    <div className="flex w-full items-center gap-2">
      <Button
        onClick={submitStateChanges}
        color={stateChangesChanged || selectedSceneId !== currentSceneId ? 'primary' : 'secondary'}
        size="small"
      >
        Apply changes
      </Button>
      <Button onClick={() => resetStateChanges()} color="secondary" size="small">
        Reset
      </Button>
      <Button onClick={sync} disabled={stateRecordsLoading} color="secondary" size="small">
        {loading ? <Spinner color="white" /> : 'Sync'}
      </Button>
    </div>
  )

  return (
    <div className="space-y-4">
      {buttons}

      <div className="space-y-2">
        <Select
          options={scenesAsOptions}
          onChange={(sceneId) => setSelectedSceneId(sceneId)}
          value={selectedSceneId ?? ''}
        />
      </div>

      <div className="flex justify-between w-full items-center gap-2">
        <H6>Scene's state:</H6>
        <Tooltip
          title={
            <>
              The fields seen here are be available as <code className="text-xs">{'state{"fieldName"}.getStr()'}</code>{' '}
              in any app in this scene. The state is just Nim's{' '}
              <a href="https://nim-lang.org/docs/json.html" target="_blank" rel="noreferer">
                <code className="text-xs underline">JsonNode</code>
              </a>
              , so access it accordingly. This means use <code className="text-xs">{'state{"field"}.getStr()'}</code> to
              access values, and <pre className="text-xs">{'state{"field"} = %*("str")'}</pre>
              to store values.
            </>
          }
        />
      </div>

      {fieldCount === 0 && !stateRecordsLoading ? (
        <div>This scene does not export publicly controllable state. Use the "Scene State" panel to configure.</div>
      ) : selectedSceneId ? (
        <Form logic={controlLogic} props={{ frameId }} formKey="stateChanges" className="space-y-4">
          <Group name={selectedSceneId}>
            {scene?.fields?.map((field) => (
              <div className="bg-gray-900 p-2 space-y-2">
                <div className="flex items-center w-full gap-2">
                  <ClipboardDocumentIcon
                    className="w-4 h-4 min-w-4 min-h-4 cursor-pointer inline-block"
                    onClick={() =>
                      copy(`state{"${field.name}"}${fieldTypeToGetter[String(field.type ?? 'string')] ?? '.getStr()'}`)
                    }
                  />
                  <div>
                    {field.label || field.name}
                    {stateChanges[selectedSceneId]?.[field.name] &&
                    stateChanges[selectedSceneId]?.[field.name] !== (state[field.name] ?? field.value) ? (
                      <Tag color="primary" className="ml-1">
                        Modified
                      </Tag>
                    ) : null}
                  </div>
                  {field.access !== 'public' ? (
                    <Tooltip title="This is a private field whose state is not shared externally" />
                  ) : null}
                </div>
                <div>
                  {field.access !== 'public' ? null : field.type === 'select' ? (
                    <Field name={field.name}>
                      {({ value, onChange }) => (
                        <Select
                          placeholder={field.placeholder}
                          value={
                            stateChanges[selectedSceneId]?.[field.name] ?? state[field.name] ?? value ?? field.value
                          }
                          onChange={onChange}
                          options={(field.options ?? []).map((option) => ({ label: option, value: option }))}
                        />
                      )}
                    </Field>
                  ) : field.type === 'text' ? (
                    <Field name={field.name}>
                      {({ value, onChange }) => (
                        <TextArea
                          placeholder={field.placeholder}
                          value={
                            stateChanges[selectedSceneId]?.[field.name] ?? state[field.name] ?? value ?? field.value
                          }
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
                          value={
                            stateChanges[selectedSceneId]?.[field.name] ?? state[field.name] ?? value ?? field.value
                          }
                          onChange={onChange}
                        />
                      )}
                    </Field>
                  )}
                </div>
              </div>
            ))}
          </Group>
        </Form>
      ) : (
        <Spinner />
      )}
      {buttons}
    </div>
  )
}

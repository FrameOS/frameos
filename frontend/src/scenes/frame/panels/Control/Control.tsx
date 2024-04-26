import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { controlLogic } from './controlLogic'
import { Form } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { TextInput } from '../../../../components/TextInput'
import { Select } from '../../../../components/Select'
import { Button } from '../../../../components/Button'
import { Tooltip } from '../../../../components/Tooltip'
import { Spinner } from '../../../../components/Spinner'
import { TextArea } from '../../../../components/TextArea'
import { H6 } from '../../../../components/H6'
import { PencilSquareIcon } from '@heroicons/react/24/outline'
import { panelsLogic } from '../panelsLogic'

// TODO: replace this with the actual proxied frame control URL
export function Control(): JSX.Element {
  const { frameId } = useValues(frameLogic)
  const {
    scene,
    sceneId,
    stateChanges,
    stateRecordLoading,
    loading,
    state,
    sceneChanging,
    stateChangesChanged,
    scenesAsOptions,
    fields,
  } = useValues(controlLogic({ frameId }))
  const { setCurrentScene, sync, submitStateChanges, resetStateChanges } = useActions(controlLogic({ frameId }))
  const { editScene } = useActions(panelsLogic({ frameId }))
  const fieldCount = fields.length ?? 0

  return (
    <div>
      <div className="space-y-2 mb-4">
        <div className="flex justify-between w-full items-center gap-2">
          <H6>Currently active scene:</H6>
          <Button onClick={sync} disabled={stateRecordLoading} color="secondary" size="small">
            {loading ? <Spinner color="white" /> : 'Sync'}
          </Button>
        </div>
        <div className="flex w-full items-center gap-2">
          <Select
            disabled={sceneChanging}
            options={scenesAsOptions}
            onChange={(sceneId) => setCurrentScene(sceneId)}
            value={sceneId}
          />
          <PencilSquareIcon className="w-5 h-5 cursor-pointer" onClick={() => editScene(sceneId)} />
        </div>
      </div>
      <div className="flex justify-between w-full items-center gap-2">
        <H6>Control the active scene:</H6>
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

      {fieldCount === 0 ? (
        <div>This scene does not export publicly controllable state. Use the "State" panel to configure.</div>
      ) : (
        <Form logic={controlLogic} props={{ frameId, sceneId }} formKey="stateChanges" className="space-y-4">
          {fields.map((field) => (
            <div className="bg-gray-900 p-2 space-y-2">
              <div className="flex items-center w-full gap-2">
                {field.label || field.name}
                {field.name in stateChanges && stateChanges[field.name] !== (state[field.name] ?? field.value)
                  ? ' (modified)'
                  : ''}
              </div>
              <div>
                {field.type === 'select' ? (
                  <Field name={field.name}>
                    {({ value, onChange }) => (
                      <Select
                        placeholder={field.placeholder}
                        value={stateChanges[field.name] ?? state[field.name] ?? value ?? field.value}
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
                        value={stateChanges[field.name] ?? state[field.name] ?? value ?? field.value}
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
                        value={stateChanges[field.name] ?? state[field.name] ?? value ?? field.value}
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
              <Button onClick={submitStateChanges} color={stateChangesChanged ? 'primary' : 'secondary'}>
                Send changes to frame
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

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
import React from 'react'
import copy from 'copy-to-clipboard'
import { Spinner } from '../../../../components/Spinner'
import { TextArea } from '../../../../components/TextArea'

const PERSIST_OPTIONS = [
  { label: 'memory (reset on boot)', value: 'memory' },
  { label: 'disk (or sd card)', value: 'disk' },
]

const ACCESS_OPTIONS = [
  { label: 'private (use in the scene)', value: 'private' },
  { label: 'public (controllable externally)', value: 'public' },
]

export function SceneState(): JSX.Element {
  const sceneId = 'default'
  const { frameId } = useValues(frameLogic)
  const {
    sceneForm,
    stateChanges,
    editingFields,
    stateLoading,
    state,
    isSceneFormSubmitting,
    sceneFormChanged,
    stateChangesChanged,
  } = useValues(sceneStateLogic({ frameId, sceneId }))
  const { setSceneFormValue, editFields, resetFields, sync, submitSceneForm, submitStateChanges, resetStateChanges } =
    useActions(sceneStateLogic({ frameId, sceneId }))

  if (!sceneForm) {
    return <></>
  }

  return (
    <div>
      <div className="flex justify-between w-full items-center gap-2 mb-2">
        <div className="flex items-center gap-2">
          <code className="font-bold">state</code>
          <Tooltip
            title={
              <>
                The fields you set here will be available through{' '}
                <code className="text-xs">{'state{"fieldName"}.getStr'}</code> in any app in this scene. The state is
                just Nim's <code className="text-xs">JsonNode</code>, so access it accordingly. This means use{' '}
                <code className="text-xs">{'state{"field"}.getStr'}</code> to access values, and{' '}
                <pre className="text-xs">{'state{"field"} = %*("str")'}</pre>
                to store scalar values.
              </>
            }
          />
        </div>
        <div className="flex items-center gap-2">
          {editingFields ? (
            <>
              <Button
                onClick={() => {
                  const newFields = [...(sceneForm.fields ?? []), { name: '', label: '', type: 'string' }]
                  setSceneFormValue('fields', newFields)
                }}
                size="small"
                color="secondary"
              >
                Add field
              </Button>
              <Button onClick={resetFields} size="small" color="secondary">
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button onClick={sync} disabled={stateLoading} size="small">
                {stateLoading ? <Spinner className="text-white" /> : 'Sync'}
              </Button>
              <Button onClick={editFields} size="small" color="secondary">
                Edit fields
              </Button>
            </>
          )}
        </div>
      </div>
      {editingFields ? (
        <Form logic={sceneStateLogic} props={{ frameId, sceneId }} formKey="sceneForm" className="space-y-4">
          {sceneForm.fields?.map((field, index) => (
            <Group name={['fields', index]}>
              <div className="bg-gray-900 p-2 space-y-4">
                <Field name="name" label="Name (keyword in code)">
                  <TextInput />
                </Field>
                <Field name="type" label="Type of field">
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
                <Field name="label" label="Label (for user entry)">
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
                      setSceneFormValue(
                        'fields',
                        (sceneForm.fields ?? []).map((f, i) => (i === index ? undefined : f)).filter(Boolean)
                      )
                    }}
                    size="small"
                    color="secondary"
                  >
                    <span className="text-red-300">Remove field</span>
                  </Button>
                </div>
              </div>
            </Group>
          ))}
          <div className="flex w-full items-center gap-2">
            <Button
              onClick={submitSceneForm}
              color={sceneFormChanged ? 'primary' : 'secondary'}
              disabled={isSceneFormSubmitting}
            >
              Save changes
            </Button>
            <Button onClick={resetFields} color="secondary">
              Cancel
            </Button>
            <div>
              <Tooltip title="Remember, after saving changes here, you must also save the scene for these changes to persist" />
            </div>
          </div>
        </Form>
      ) : (
        <Form logic={sceneStateLogic} props={{ frameId, sceneId }} formKey="stateChanges" className="space-y-4">
          <div className="space-y-4">
            {sceneForm.fields?.map((field, index) => (
              <div className="bg-gray-900 p-2 space-y-2">
                <div className="flex justify-between items-center w-full gap-2">
                  <div>
                    {field.label || field.name}
                    {field.name in stateChanges && stateChanges[field.name] !== (state[field.name] ?? field.value)
                      ? ' (modified)'
                      : ''}
                  </div>
                </div>
                <div>
                  {field.type === 'select' ? (
                    <Field name={field.name}>
                      {({ value, onChange }) => (
                        <Select
                          value={stateChanges[field.name] ?? state[field.name] ?? value}
                          onChange={onChange}
                          options={(field.options ?? []).map((option) => ({ label: option, value: option }))}
                        />
                      )}
                    </Field>
                  ) : (
                    <Field name={field.name}>
                      {({ value, onChange }) => (
                        <TextInput
                          placeholder=""
                          value={stateChanges[field.name] ?? state[field.name] ?? value}
                          onChange={onChange}
                        />
                      )}
                    </Field>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <ClipboardDocumentIcon
                    className="w-4 h-4 min-w-4 min-h-4 cursor-pointer inline-block"
                    onClick={() =>
                      copy(`state{"${field.name}"}${fieldTypeToGetter[String(field.type ?? 'string')] ?? '.getStr'}`)
                    }
                  />
                  <code className="text-sm text-gray-400 break-words">{`state{"${field.name}"}${
                    fieldTypeToGetter[String(field.type ?? 'string')] ?? '.getStr()'
                  }`}</code>
                </div>
              </div>
            ))}
            <div className="flex w-full items-center gap-2">
              <Button onClick={submitStateChanges} color={stateChangesChanged ? 'primary' : 'secondary'}>
                Send changes to frame
              </Button>
              <Button onClick={() => resetStateChanges()} color="secondary">
                Reset
              </Button>
            </div>
          </div>
        </Form>
      )}
    </div>
  )
}

import { Field } from '../../../../components/Field'
import { Select } from '../../../../components/Select'
import { Switch } from '../../../../components/Switch'
import { TextArea } from '../../../../components/TextArea'
import { TextInput } from '../../../../components/TextInput'
import { appConfigFieldTypes, type AppConfigField, type StateField } from '../../../../types'
import { Button } from '../../../../components/Button'

export function codenameToLabel(codename: string): string {
  const label = codename
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : ''
}

interface FieldDefinitionFormProps<T extends AppConfigField> {
  field: T
  fields: T[]
  index: number
  setFields: (fields: T[]) => void
  closeField: (index: number) => void
  removeField: (index: number) => void
  includeStateOptions?: boolean
  removeLabel?: string
}

export function FieldDefinitionForm<T extends AppConfigField>({
  field,
  fields,
  index,
  setFields,
  closeField,
  removeField,
  includeStateOptions = false,
  removeLabel = 'Remove field',
}: FieldDefinitionFormProps<T>): JSX.Element {
  return (
    <div className="frame-tool-card space-y-4 rounded-2xl p-4">
      <Field name="name" label="Codename">
        {({ value }) => (
          <TextInput
            placeholder="e.g. searchTerm"
            value={value}
            onChange={(value) => {
              setFields(
                fields.map((field, i) => {
                  if (i !== index) {
                    return field
                  }
                  const currentGeneratedLabel = codenameToLabel(field.name ?? '')
                  const labelWasGenerated = field.label === currentGeneratedLabel
                  return {
                    ...field,
                    name: value,
                    label: labelWasGenerated ? codenameToLabel(value) : field.label,
                  }
                })
              )
            }}
          />
        )}
      </Field>
      <Field name="label" label="Label">
        <TextInput placeholder="e.g. Search Term" />
      </Field>
      <Field name="type" label="Field type">
        <Select options={appConfigFieldTypes.filter((f) => f !== 'node').map((k) => ({ label: k, value: k }))} />
      </Field>
      {field.type === 'select' ? (
        <Field name="options" label="Options (one per line)">
          <TextArea
            value={(field.options ?? []).join('\n')}
            rows={3}
            onChange={(value) =>
              setFields(fields.map((field, i) => (i === index ? { ...field, options: value.split('\n') } : field)))
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
      {includeStateOptions ? (
        <>
          <Field
            name="persist"
            label="Persist on disk"
            tooltip={
              <>
                Do not persist to disk values that change rapidly, as this will noticably impact the lifetime of your SD
                card.
              </>
            }
          >
            {({ value, onChange }) => (
              <Switch
                aria-label="Persist on disk"
                value={value === 'disk'}
                onChange={(enabled) => onChange(enabled ? 'disk' : 'memory')}
              />
            )}
          </Field>
          <Field
            name="access"
            label="Can be set by user"
            tooltip={
              <>
                When enabled, this field becomes part of the scene options that can be controlled externally. When
                disabled, it is only accessible inside the scene.
              </>
            }
          >
            {({ value, onChange }) => (
              <Switch
                aria-label="Can be set by user"
                value={(value as StateField['access']) === 'public'}
                onChange={(enabled) => onChange(enabled ? 'public' : 'private')}
              />
            )}
          </Field>
        </>
      ) : null}
      <div className="flex w-full items-center justify-between gap-2">
        <Button
          onClick={() => {
            closeField(index)
          }}
          disabled={!field.name?.trim()}
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
          <span className="text-red-300">{removeLabel}</span>
        </Button>
      </div>
    </div>
  )
}

import { Field } from '../../../../components/Field'
import { Select } from '../../../../components/Select'
import { selectOptionsFromText, selectOptionsToText } from '../../../../utils/selectOptions'
import { Switch } from '../../../../components/Switch'
import { TextArea } from '../../../../components/TextArea'
import { TextInput } from '../../../../components/TextInput'
import { appConfigFieldTypes, type AppConfigField, type StateField } from '../../../../types'
import { Button } from '../../../../components/Button'
import { ShowIfEditor, type ShowIfConditions } from './ShowIfEditor'
import {
  REFRESH_INTERVAL_LABEL,
  REFRESH_INTERVAL_ROLE,
  refreshIntervalFieldIndex,
} from '../../../../utils/refreshInterval'

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

/**
 * "Use as refresh interval": at most one state field carries the role. A
 * float or integer field literally named `refreshInterval` has it by name
 * (unless another field took the role), so its switch is on and locked.
 */
function RefreshIntervalRoleField<T extends AppConfigField>({
  fields,
  index,
  setFields,
}: {
  fields: T[]
  index: number
  setFields: (fields: T[]) => void
}): JSX.Element {
  const stateFields = fields as StateField[]
  const active = refreshIntervalFieldIndex(stateFields) === index
  const byName = active && stateFields[index]?.role !== REFRESH_INTERVAL_ROLE
  return (
    <Field
      name="role"
      label="Use as refresh interval"
      tooltip={
        <>
          The value of this field is how many seconds the scene waits between renders, replacing the "
          {REFRESH_INTERVAL_LABEL}" control every scene otherwise gets as its last option. The field stays where you put
          it; make it private to keep the interval out of people's hands. Only one field per scene can have this role,
          and a float or integer field named <code>refreshInterval</code> has it automatically.
        </>
      }
    >
      {() => (
        <Switch
          aria-label="Use as refresh interval"
          value={active}
          disabled={byName}
          onChange={(enabled) =>
            setFields(
              fields.map((other, i) => {
                const { role: _role, ...rest } = other as StateField
                return (i === index && enabled ? { ...rest, role: REFRESH_INTERVAL_ROLE } : rest) as T
              })
            )
          }
        />
      )}
    </Field>
  )
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
        <Field
          name="options"
          label='Options (one per line, "value | Label" to show a different label, "\|" for a literal "|")'
        >
          <TextArea
            value={selectOptionsToText(field.options)}
            rows={3}
            onChange={(value) =>
              setFields(
                fields.map((field, i) => (i === index ? { ...field, options: selectOptionsFromText(value) } : field))
              )
            }
          />
        </Field>
      ) : null}
      {field.type === 'path' ? (
        <>
          <Field name="pick" label="Points at">
            <Select
              value={field.pick ?? 'file'}
              options={[
                { value: 'file', label: 'A file' },
                { value: 'folder', label: 'A folder' },
                { value: 'any', label: 'A file or a folder' },
              ]}
              onChange={(value) =>
                setFields(
                  fields.map((field, i) => (i === index ? { ...field, pick: value as AppConfigField['pick'] } : field))
                )
              }
            />
          </Field>
          <Field
            name="extensions"
            label="Allowed file extensions"
            tooltip={<>Comma-separated, without dots — e.g. "jpg, png". Leave empty to allow any file.</>}
          >
            <TextInput
              value={(field.extensions ?? []).join(', ')}
              placeholder="e.g. jpg, png"
              onChange={(value) => {
                const extensions = value
                  .split(/[\s,]+/)
                  .map((extension) => extension.replace(/^\.+/, '').trim())
                  .filter(Boolean)
                setFields(
                  fields.map((field, i) =>
                    i === index ? { ...field, extensions: extensions.length > 0 ? extensions : undefined } : field
                  )
                )
              }}
            />
          </Field>
        </>
      ) : null}
      <Field name="value" label="Initial value">
        <TextInput />
      </Field>
      <Field name="placeholder" label="Placeholder">
        <TextInput />
      </Field>
      <Field
        name="showIf"
        label="Show only if"
        tooltip={
          <>
            Hide this field from forms unless the conditions below match. Conditions can reference the other{' '}
            {includeStateOptions ? 'public state fields' : 'fields'} and are re-evaluated as values change.
          </>
        }
      >
        {({ value }) => (
          <ShowIfEditor
            value={value as ShowIfConditions | undefined}
            availableFields={fields.filter(
              (otherField, otherIndex) =>
                otherIndex !== index &&
                !!otherField.name &&
                (!includeStateOptions || (otherField as StateField).access === 'public')
            )}
            onChange={(showIf) =>
              setFields(
                fields.map((currentField, i) => {
                  if (i !== index) {
                    return currentField
                  }
                  if (showIf && showIf.length > 0) {
                    return { ...currentField, showIf }
                  }
                  const { showIf: _removed, ...rest } = currentField
                  return rest as T
                })
              )
            }
          />
        )}
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
          <RefreshIntervalRoleField fields={fields} index={index} setFields={setFields} />
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

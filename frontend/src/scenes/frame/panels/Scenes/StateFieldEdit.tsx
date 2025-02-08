import { FontSelect } from '../../../../components/FontSelect'
import { Select } from '../../../../components/Select'
import { TextArea } from '../../../../components/TextArea'
import { TextInput } from '../../../../components/TextInput'
import { StateField } from '../../../../types'

interface StateFieldEditProps {
  field: StateField
  value: string
  onChange: (value: string) => void
  currentState: Record<string, any>
  stateChanges: Record<string, any>
}

export function StateFieldEdit({
  field,
  stateChanges,
  currentState,
  value,
  onChange,
}: StateFieldEditProps): JSX.Element {
  return field.type === 'select' ? (
    <Select
      value={stateChanges[field.name] ?? currentState[field.name] ?? value ?? field.value}
      onChange={onChange}
      options={(field.options ?? []).map((option) => ({ label: option, value: option }))}
    />
  ) : field.type === 'boolean' ? (
    <Select
      value={stateChanges[field.name] ?? currentState[field.name] ?? value ?? field.value}
      onChange={onChange}
      options={['true', 'false'].map((option) => ({ label: option, value: option }))}
    />
  ) : field.type === 'text' ? (
    <TextArea
      placeholder={field.placeholder}
      value={stateChanges[field.name] ?? currentState[field.name] ?? value ?? field.value}
      onChange={onChange}
      rows={3}
    />
  ) : field.type === 'font' ? (
    <FontSelect
      value={stateChanges[field.name] ?? currentState[field.name] ?? value ?? field.value}
      onChange={onChange}
    />
  ) : (
    <TextInput
      placeholder={field.placeholder}
      value={stateChanges[field.name] ?? currentState[field.name] ?? value ?? field.value}
      onChange={onChange}
    />
  )
}

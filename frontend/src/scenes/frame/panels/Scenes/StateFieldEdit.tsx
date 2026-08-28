import { ColorInput } from '../../../../components/ColorInput'
import { FontSelect } from '../../../../components/FontSelect'
import { NumberTextInput } from '../../../../components/NumberTextInput'
import { Select } from '../../../../components/Select'
import { selectFieldOptions } from '../../../../utils/selectOptions'
import { TextArea } from '../../../../components/TextArea'
import { TextInput } from '../../../../components/TextInput'
import { PathInput } from '../Assets/PathInput'
import { FrameId, StateField } from '../../../../types'

interface StateFieldEditProps {
  field: StateField
  value: string
  onChange: (value: any) => void
  currentState: Record<string, any>
  stateChanges: Record<string, any>
  /** Enables the file/folder picker for 'path' fields; without it they render as plain text. */
  frameId?: FrameId
}

export function StateFieldEdit({
  field,
  stateChanges,
  currentState,
  value,
  onChange,
  frameId,
}: StateFieldEditProps): JSX.Element {
  return field.type === 'path' && frameId !== undefined ? (
    <PathInput
      frameId={frameId}
      placeholder={field.placeholder}
      value={stateChanges[field.name] ?? currentState[field.name] ?? value ?? field.value}
      onChange={onChange}
      pick={field.pick}
      extensions={field.extensions}
    />
  ) : field.type === 'select' ? (
    <Select
      value={stateChanges[field.name] ?? currentState[field.name] ?? value ?? field.value}
      onChange={onChange}
      options={selectFieldOptions(field.options)}
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
  ) : field.type === 'integer' || field.type === 'float' ? (
    <NumberTextInput
      placeholder={field.placeholder}
      value={stateChanges[field.name] ?? currentState[field.name] ?? value ?? field.value}
      onChange={onChange}
    />
  ) : field.type === 'color' ? (
    <ColorInput
      placeholder={field.placeholder}
      value={stateChanges[field.name] ?? currentState[field.name] ?? value ?? field.value}
      onChange={onChange}
      className="!p-0"
    />
  ) : field.type === 'date' ? (
    <TextInput
      type="date"
      placeholder={field.placeholder}
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

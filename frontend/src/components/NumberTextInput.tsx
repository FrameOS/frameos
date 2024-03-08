import React, { useEffect } from 'react'
import { clsx } from 'clsx'
import { TextInput, TextInputProps } from './TextInput'

export interface NumberTextInputProps extends Omit<TextInputProps, 'onChange' | 'value'> {
  value?: number
  onChange?: (value: number | undefined) => void
}

export function NumberTextInput({ value, onChange, ...props }: NumberTextInputProps) {
  const [internalValue, setInternalValue] = React.useState(value?.toString() ?? '')
  useEffect(() => {
    if (value !== undefined) {
      setInternalValue(value.toString())
    } else {
      setInternalValue('')
    }
  }, [value])
  return (
    <TextInput
      value={internalValue}
      onChange={
        onChange
          ? (newValue) => {
              setInternalValue(newValue)
              if (newValue && Number.isFinite(parseFloat(String(newValue)))) {
                onChange(parseFloat(newValue))
              } else if (newValue === '') {
                onChange(undefined)
              }
            }
          : undefined
      }
      {...props}
    />
  )
}

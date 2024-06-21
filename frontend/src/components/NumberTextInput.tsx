import React, { useEffect } from 'react'
import { clsx } from 'clsx'
import { TextInput, TextInputProps } from './TextInput'

export interface NumberTextInputProps extends Omit<TextInputProps, 'onChange' | 'value'> {
  value?: number
  onChange?: (value: number | undefined) => void
}

export function NumberTextInput({ value, onChange, onBlur, ...props }: NumberTextInputProps) {
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
      onBlur={(e) => {
        if (internalValue && Number.isFinite(parseFloat(String(internalValue)))) {
          onChange?.(parseFloat(internalValue))
        } else {
          onChange?.(undefined)
        }
        onBlur?.(e)
      }}
      onChange={(e) => {
        setInternalValue(e)
      }}
      {...props}
    />
  )
}

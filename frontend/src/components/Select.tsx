import React from 'react'
import clsx from 'clsx'

export interface Option {
  value: string
  label: string
}

export interface NumericOption {
  value: number
  label: string
}

export type SelectOption = Option | NumericOption

export interface OptionGroup<T extends SelectOption = SelectOption> {
  label: string
  options: T[]
}

export type SelectOptionEntry<T extends SelectOption = SelectOption> = T | OptionGroup<T>

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  onChange?: (value: string) => void
  options: SelectOptionEntry[]
  theme?: 'node' | 'full'
}

function isOptionGroup(option: SelectOptionEntry): option is OptionGroup {
  return 'options' in option
}

function renderOption(option: SelectOption): JSX.Element {
  return (
    <option key={String(option.value)} value={option.value}>
      {option.label}
    </option>
  )
}

export function Select({ className, onChange, options, theme, value, ...props }: SelectProps) {
  return (
    <select
      className={clsx(
        (!theme || theme === 'full') &&
          'frameos-control border text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full px-2.5 py-1.5',
        theme === 'node' &&
          'frameos-node-control block focus:ring-1 focus:ring-blue-500 w-full px-0.5 appearance-none with-triangle pr-6',
        className
      )}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      {...(value === null ? { value: '' } : value !== undefined ? { value } : {})}
      {...props}
    >
      {options.map((option) =>
        isOptionGroup(option) ? (
          <optgroup key={option.label} label={option.label}>
            {option.options.map(renderOption)}
          </optgroup>
        ) : (
          renderOption(option)
        )
      )}
    </select>
  )
}

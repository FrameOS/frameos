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

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  onChange?: (value: string) => void
  options: Option[] | NumericOption[]
  theme?: 'node' | 'full'
}

export function Select({ className, onChange, options, theme, ...props }: SelectProps) {
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
      {...props}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

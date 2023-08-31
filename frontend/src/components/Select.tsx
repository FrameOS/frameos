import React from 'react'
import clsx from 'clsx'

interface Option {
  value: string
  label: string
}

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  onChange?: (value: string) => void
  options: Option[]
  theme?: 'node' | 'full'
}

export function Select({ className, onChange, options, theme, ...props }: SelectProps) {
  return (
    <select
      className={clsx(
        (!theme || theme === 'full') &&
          'border text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 bg-gray-600 border-gray-500 text-white',
        theme === 'node' &&
          'block text-white bg-zinc-800 focus:bg-zinc-700 hover:bg-zinc-700 w-full px-0.5 appearance-none with-triangle pr-6',
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

import React from 'react'
import clsx from 'clsx'

export interface Option {
  value: string
  label: string
  disabled?: boolean
}

export interface NumericOption {
  value: number
  label: string
  disabled?: boolean
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
    <option key={String(option.value)} value={option.value} disabled={option.disabled}>
      {/* A non-string label (scenes have shipped `{ value, label }` option objects) would
          crash the whole editor as an invalid React child, so never render one raw. */}
      {typeof option.label === 'string' ? option.label : String(option.label ?? '')}
    </option>
  )
}

function optionValues(options: SelectOptionEntry[]): Set<string> {
  const values = new Set<string>()
  for (const option of options) {
    if (isOptionGroup(option)) {
      option.options.forEach((entry) => values.add(String(entry.value)))
    } else {
      values.add(String(option.value))
    }
  }
  return values
}

export function Select({ className, onChange, options, theme, value, ...props }: SelectProps) {
  // A native <select> whose value matches no <option> shows the first option
  // while the form still holds the old value: a field pointing at a scene or
  // state key that was renamed looked like it had picked the first entry, and
  // saving kept the stale one. Show the stored value instead, so what the user
  // sees is what gets saved.
  // An empty string is the placeholder idiom ("nothing chosen") and is left
  // to the browser.
  const stored = value === null || value === undefined || Array.isArray(value) ? '' : String(value)
  const missing = stored !== '' && !optionValues(options).has(stored)
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
      {missing ? (
        <option key={`missing:${stored}`} value={stored}>
          {`${stored} (not an option)`}
        </option>
      ) : null}
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

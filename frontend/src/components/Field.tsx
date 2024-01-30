import React from 'react'
import { clsx } from 'clsx'
import { FieldProps as KeaFieldProps, Field as KeaField } from 'kea-forms'
import { Label } from './Label'
import { Reveal } from './Reveal'
import { Tooltip } from './Tooltip'

interface FieldProps extends KeaFieldProps {
  label: JSX.Element | string
  hint?: JSX.Element | string
  tooltip?: JSX.Element | string
  className?: string
  secret?: boolean
}

export function Field({
  children,
  name,
  label,
  className,
  secret,
  hint,
  tooltip,
  ...props
}: FieldProps): ReturnType<typeof KeaField> {
  const template: KeaFieldProps['template'] = ({ label, kids, error }) => {
    return (
      <div className={clsx('space-y-1', className)}>
        <>
          {label ? (
            <Label>
              {label}
              {tooltip ? <Tooltip title={tooltip} /> : null}
            </Label>
          ) : null}
          {secret ? (
            <Reveal className="border rounded-lg w-full px-2.5 py-1.5 py-4 bg-gray-600 border-gray-500">
              {kids as any}
            </Reveal>
          ) : (
            kids
          )}
          {error ? <div className="flex items-center gap-1 text-sm text-red-400">{error}</div> : null}
          {hint ? <div className="flex items-center gap-1 text-xs">{hint}</div> : null}
        </>
      </div>
    )
  }
  return <KeaField {...props} children={children} name={name} label={label} template={template} noStyle />
}

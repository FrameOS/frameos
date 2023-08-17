import React from 'react'
import { clsx } from 'clsx'
import { FieldProps as KeaFieldProps, Field as KeaField } from 'kea-forms'
import { Label } from './Label'

interface FieldProps extends KeaFieldProps {
  label: JSX.Element | string
  className?: string
}

export function Field({ children, name, label, className, ...props }: FieldProps): ReturnType<typeof KeaField> {
  const template: KeaFieldProps['template'] = ({ label, kids, error }) => {
    return (
      <div className={clsx('space-y-2', className)}>
        {label ? (
          <Label htmlFor={Array.isArray(name) ? name.map((name) => String(name)).join('.') : String(name)}>
            {label}
          </Label>
        ) : null}
        {kids as any}
        {error ? <div className="text-danger flex items-center gap-1 text-sm text-red-300">{error}</div> : null}
      </div>
    )
  }
  return <KeaField {...props} children={children} name={name} template={template} noStyle />
}

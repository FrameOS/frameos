import React from 'react'
import { clsx } from 'clsx'
import { FieldProps as KeaFieldProps, Field as KeaField } from 'kea-forms'
import { Label } from './Label'
import { Reveal } from './Reveal'

interface FieldProps extends KeaFieldProps {
  label: JSX.Element | string
  className?: string
  secret?: boolean
}

export function Field({ children, name, label, className, secret, ...props }: FieldProps): ReturnType<typeof KeaField> {
  const template: KeaFieldProps['template'] = ({ label, kids, error }) => {
    return (
      <div className={clsx('space-y-2', className)}>
        <>
          {label ? <Label>{label}</Label> : null}
          {secret ? (
            <Reveal className="border rounded-lg w-full p-2.5 py-4 bg-gray-600 border-gray-500">{kids as any}</Reveal>
          ) : (
            kids
          )}
          {error ? <div className="text-danger flex items-center gap-1 text-sm text-red-400">{error}</div> : null}
        </>
      </div>
    )
  }
  return <KeaField {...props} children={children} name={name} label={label} template={template} noStyle />
}

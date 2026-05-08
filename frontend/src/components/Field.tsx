import { clsx } from 'clsx'
import { FieldProps as KeaFieldProps, Field as KeaField } from 'kea-forms'
import { Label } from './Label'
import { Tooltip } from './Tooltip'
import { SecretField } from './SecretField'

interface FieldProps extends KeaFieldProps {
  label?: JSX.Element | string
  labelRight?: JSX.Element | string
  hint?: JSX.Element | string
  tooltip?: JSX.Element | string
  className?: string
  secret?: boolean
}

export function Field({
  children,
  name,
  label,
  labelRight,
  className,
  secret,
  hint,
  tooltip,
  ...props
}: FieldProps): ReturnType<typeof KeaField> {
  const labelNode = label ? (
    <Label className={!labelRight ? '@md:w-1/3' : ''}>
      {label}
      {tooltip ? <Tooltip title={tooltip} /> : null}
    </Label>
  ) : null
  const template: KeaFieldProps['template'] = ({ label, kids, error }) => {
    return (
      <div
        className={clsx('space-y-1 @md:flex @md:gap-2', className)}
        {...(error ? { 'data-field-with-error': true } : {})}
      >
        <>
          {labelRight ? (
            <div className="flex w-full justify-between items-center @md:w-1/3">
              {labelNode}
              {labelRight}
            </div>
          ) : (
            labelNode
          )}
          <div className="w-full">
            {secret ? <SecretField>{kids as any}</SecretField> : (kids as any)}
            {error ? <div className="flex items-center gap-1 text-sm text-red-400">{error}</div> : null}
            {hint ? <div className="flex items-center gap-1 text-sm">{hint}</div> : null}
          </div>
        </>
      </div>
    )
  }
  return <KeaField {...props} children={children} name={name} label={label} template={template} noStyle />
}

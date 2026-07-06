import clsx from 'clsx'
import { ButtonProps } from './Button'

export interface TagProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
  color?: ButtonProps['color'] | 'purple' | 'green' | 'pink'
  className?: string
}

export function Tag({ children, className, color, ...props }: TagProps) {
  return (
    <div
      className={clsx(
        'frameos-tag inline-block px-1 py-0.5 text-xs font-normal rounded-md uppercase align-middle',
        className
      )}
      data-tag-color={color || 'gray'}
      {...props}
    >
      {children}
    </div>
  )
}

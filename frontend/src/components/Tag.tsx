import clsx from 'clsx'
import { ButtonProps, buttonColor } from './Button'

interface TagProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
  color?: ButtonProps['color']
  className?: string
}

export function Tag({ children, className, color, ...props }: TagProps) {
  return (
    <div
      className={clsx(
        'inline-block px-1 py-0.5 text-xs font-normal text-gray-200 border-gray-700 rounded-md border uppercase align-middle',
        buttonColor(color || 'gray'),
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

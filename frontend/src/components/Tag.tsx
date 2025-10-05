import clsx from 'clsx'
import { ButtonProps, buttonColor } from './Button'

export interface TagProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
  color?: ButtonProps['color']
  className?: string
}

export function Tag({ children, className, color, ...props }: TagProps) {
  const textColor = color === 'yellow' ? 'text-black' : 'text-gray-200 border border-gray-700'
  return (
    <div
      className={clsx(
        `inline-block px-1 py-0.5 text-xs font-normal ${textColor} rounded-md uppercase align-middle`,
        buttonColor(color || 'gray'),
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

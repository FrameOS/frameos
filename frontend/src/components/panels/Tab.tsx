import clsx from 'clsx'
import { Button } from '../Button'
import { XMarkIcon } from '@heroicons/react/24/solid'

interface TabProps {
  active?: boolean
  children: React.ReactNode
  className?: string
  onClick?: () => void
  onDoubleClick?: () => void
  onClose?: () => void
  closable?: boolean
  activeColorClass?: string
}
export function Tab({
  children,
  active,
  className,
  onClick,
  onDoubleClick,
  onClose,
  closable,
  activeColorClass,
}: TabProps): JSX.Element {
  return (
    <div
      className={clsx(
        'flex gap-1 w-auto text-white focus:ring-4 focus:outline-none font-medium px-2 py-1 text-base text-center cursor-pointer border border-b-0',
        active
          ? `${activeColorClass || 'bg-gray-800'} border-gray-700 hover:bg-gray-500 focus:ring-gray-500`
          : 'border-transparent hover:bg-gray-500 focus:ring-gray-500',
        className
      )}
      title={typeof children === 'string' ? children : undefined}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div className="truncate">{children}</div>
      {closable ? (
        <Button size="tiny" color="none-gray" className="text-sm text-white" onClick={onClose}>
          <XMarkIcon className="w-4 h-4" />
        </Button>
      ) : null}
    </div>
  )
}

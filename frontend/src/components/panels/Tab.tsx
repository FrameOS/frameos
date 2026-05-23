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
        'flex gap-1 w-auto frameos-strong focus:ring-4 focus:outline-none font-medium px-2 py-1 text-base text-center cursor-pointer border border-b-0 rounded-t-md transition',
        active
          ? `${activeColorClass || 'frameos-inset'} border-slate-300/70 focus:ring-blue-400`
          : 'border-transparent hover:bg-white/55 focus:ring-blue-400',
        className
      )}
      title={typeof children === 'string' ? children : undefined}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div className="truncate">{children}</div>
      {closable ? (
        <Button size="tiny" color="none-gray" className="text-sm" onClick={onClose}>
          <XMarkIcon className="w-4 h-4" />
        </Button>
      ) : null}
    </div>
  )
}

import clsx from 'clsx'

interface TabProps {
  active?: boolean
  children: React.ReactNode
  className?: string
  onClick?: () => void
}
export function Tab({ children, active, className, onClick }: TabProps): JSX.Element {
  return (
    <div
      className={clsx(
        'w-auto text-white focus:ring-4 focus:outline-none font-medium px-2 py-1 text-base text-center cursor-pointer border border-b-0 truncate',
        active
          ? 'bg-gray-800 border-gray-700 hover:bg-gray-500 focus:ring-gray-500'
          : 'border-transparent hover:bg-gray-500 focus:ring-gray-500',

        className
      )}
      title={typeof children === 'string' ? children : undefined}
      onClick={onClick}
    >
      {children}
    </div>
  )
}

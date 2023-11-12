import clsx from 'clsx'

interface TabsProps {
  children: React.ReactNode
  className?: string
}

export function Tabs({ children, className }: TabsProps): JSX.Element {
  return (
    <div
      className={clsx(
        'flex flex-wrap items-start text-sm font-medium text-center text-gray-500 dark:border-gray-700 dark:text-gray-400 space-x-2 w-full max-w-full',
        className
      )}
    >
      {children}
    </div>
  )
}

import clsx from 'clsx'

interface TabsProps {
  children: React.ReactNode
  className?: string
}

export function Tabs({ children, className }: TabsProps): JSX.Element {
  return (
    <div
      className={clsx(
        'frameos-muted flex flex-wrap items-start text-sm font-medium text-center space-x-2 w-full max-w-full',
        className
      )}
    >
      {children}
    </div>
  )
}

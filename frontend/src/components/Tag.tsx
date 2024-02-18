import clsx from 'clsx'

interface TagProps {
  children: React.ReactNode
  className?: string
}

export function Tag({ children, className }: TagProps) {
  return (
    <div
      className={clsx(
        'inline-block px-1 py-0.5 text-xs font-normal text-gray-400 bg-gray-800 rounded-md border border-gray-700 uppercase align-middle',
        className
      )}
    >
      {children}
    </div>
  )
}

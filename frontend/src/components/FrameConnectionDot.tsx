import clsx from 'clsx'

interface FrameConnectionDotProps {
  title?: string
  size?: 'sm' | 'md'
  className?: string
}

export function FrameConnectionDot({
  title = 'FrameOS Remote connected',
  size = 'md',
  className,
}: FrameConnectionDotProps): JSX.Element {
  const sizeClassName = size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5'

  return (
    <span
      title={title}
      className={clsx(
        'frameos-connection-dot relative inline-flex shrink-0 items-center justify-center',
        sizeClassName,
        className
      )}
    >
      <span className="frameos-connection-dot__flow" />
      <span className="frameos-connection-dot__flow frameos-connection-dot__flow--delayed" />
      <span className={clsx('frameos-connection-dot__core relative inline-flex rounded-full', sizeClassName)} />
    </span>
  )
}

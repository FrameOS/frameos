import { PanelResizeHandle } from 'react-resizable-panels'
import clsx from 'clsx'

interface HandleProps {
  direction: 'horizontal' | 'vertical'
  className?: string
}

export function Handle({ direction, className }: HandleProps): JSX.Element {
  return (
    <PanelResizeHandle
      className={clsx(
        'bg-gray-900 hover:bg-blue-600 active:bg-blue-800 transition duration-1000',
        className,
        direction === 'horizontal' ? 'w-2 mx-1' : 'h-2 my-1'
      )}
    />
  )
}

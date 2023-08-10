import { useValues } from 'kea'
import { Box } from '../../components/Box'
import { frameLogic } from './frameLogic'
import clsx from 'clsx'

export interface ImageProps {
  className?: string
}

export function Image({ className }: ImageProps) {
  const { frame, frameLoading } = useValues(frameLogic)
  return (
    <Box className={clsx('p-2 w-fit m-auto', className)}>
      {frameLoading ? '...' : <img className="rounded-lg" src={`/images/image${(frame.id % 20) + 1}.jpg`} alt="" />}
    </Box>
  )
}

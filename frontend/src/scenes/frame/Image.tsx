import { useValues } from 'kea'
import { Box } from '../../components/Box'
import { frameLogic } from './frameLogic'
import clsx from 'clsx'

export interface ImageProps {
  className?: string
}

export function Image({ className }: ImageProps) {
  const { frame, frameLoading, frameImage } = useValues(frameLogic)
  return (
    <Box
      className={clsx('p-2 w-fit m-auto', frame?.status === 'refreshing' ? 'continuous-fade-in-out' : null, className)}
    >
      {frameLoading ? '...' : <img className="rounded-lg" src={frameImage} alt="" />}
    </Box>
  )
}

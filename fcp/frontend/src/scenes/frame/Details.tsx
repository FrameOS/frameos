import { useValues } from 'kea'
import { Box } from '../../components/Box'
import { H6 } from '../../components/H6'
import { frameLogic } from './frameLogic'
import clsx from 'clsx'

export interface DetailsProps {
  className?: string
}

export function Details({ className }: DetailsProps) {
  const { frame, frameLoading } = useValues(frameLogic)
  return (
    <Box className={clsx('p-4', className)}>
      <H6 className="mb-4">Details</H6>
      {frameLoading ? (
        '...'
      ) : (
        <>
          <div>IP or hostname: {frame.ip}</div>
          <div>Status: {frame.status}</div>
        </>
      )}
    </Box>
  )
}

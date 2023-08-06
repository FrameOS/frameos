import { useActions, useValues } from 'kea'
import { Box } from '../../components/Box'
import { H6 } from '../../components/H6'
import { frameLogic } from './frameLogic'
import clsx from 'clsx'
import { Button } from '../../components/Button'

export interface DetailsProps {
  className?: string
}

export function Details({ className }: DetailsProps) {
  const { frame, frameLoading } = useValues(frameLogic)
  const { initialize } = useActions(frameLogic)

  return (
    <Box className={clsx('p-4 space-y-4', className)}>
      <H6>Details</H6>
      {frameLoading ? (
        '...'
      ) : (
        <>
          <div>
            <div>IP or hostname: {frame.ip}</div>
            <div>Status: {frame.status}</div>
          </div>
          {frame.status === 'uninitialized' ? <Button onClick={initialize}>Initialize</Button> : null}
        </>
      )}
    </Box>
  )
}

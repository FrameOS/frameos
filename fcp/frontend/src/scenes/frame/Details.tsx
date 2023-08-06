import { useActions, useValues } from 'kea'
import { Box } from '../../components/Box'
import { H6 } from '../../components/H6'
import { frameLogic } from './frameLogic'
import clsx from 'clsx'
import { Button } from '../../components/Button'
import { frameHost, frameStatus } from '../../decorators/frame'

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
            <div>Hostname: {frame.host}</div>
            <div>SSH User: {frame.ssh_user}</div>
            <div>SSH Port: {frame.ssh_port}</div>
            <div>API Port: {frame.api_port}</div>
            {frame.version ? <div>Client Version: {frame.version}</div> : null}
            <div className="flex items-center">
              <div className="mr-2">Status:</div>
              {frameStatus(frame)}
            </div>
          </div>
          {frame.status === 'uninitialized' ? <Button onClick={initialize}>Initialize</Button> : null}
        </>
      )}
    </Box>
  )
}

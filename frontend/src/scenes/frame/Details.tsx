import { useActions, useValues } from 'kea'
import { Box } from '../../components/Box'
import { H6 } from '../../components/H6'
import clsx from 'clsx'
import { Button } from '../../components/Button'
import { frameStatus } from '../../decorators/frame'
import { Reveal } from '../../components/Reveal'
import { framesModel } from '../../models/framesModel'
import { frameLogic } from './frameLogic'

export interface DetailsProps {
  className?: string
  id: number
}

export function Details({ className, id }: DetailsProps) {
  const { frame } = useValues(frameLogic({ id }))
  const { redeployFrame, refreshFrame, restartFrame } = useActions(framesModel)

  return (
    <Box className={clsx('p-4 space-y-4', className)}>
      <H6>Details</H6>
      {!frame ? (
        `Loading frame ${id}...`
      ) : (
        <>
          <table className="table-auto border-separate border-spacing-x-1 border-spacing-y-0.5">
            <tbody>
              <tr>
                <td className="text-blue-200 text-right">Frame host:</td>
                <td>{frame.frame_host}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Frame port:</td>
                <td>{frame.frame_port}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">SSH user:</td>
                <td>{frame.ssh_user}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">SSH pass:</td>
                <td>
                  <Reveal>{frame.ssh_pass}</Reveal>
                </td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">SSH port:</td>
                <td>{frame.ssh_port}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">API host:</td>
                <td>{frame.server_host}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">API port:</td>
                <td>{frame.server_port}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">API key:</td>
                <td>
                  <Reveal>{frame.server_api_key}</Reveal>
                </td>
              </tr>
              {frame.version ? (
                <tr>
                  <td className="text-blue-200 text-right">Client version:</td>
                  <td>{frame.version}</td>
                </tr>
              ) : null}
              <tr>
                <td className="text-blue-200 text-right">Status:</td>
                <td>{frameStatus(frame)}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Device:</td>
                <td>
                  {frame.device} {frame.color} {frame.width && frame.height ? `${frame.width}x${frame.height}` : ''}
                </td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Image URL:</td>
                <td className="truncate">{frame.image_url}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Interval:</td>
                <td className="truncate">{frame.interval}</td>
              </tr>
            </tbody>
          </table>
          <div className="flex space-x-2">
            <Button type="button" onClick={() => redeployFrame(frame.id)}>
              Redeploy
            </Button>
            <Button type="button" onClick={() => restartFrame(frame.id)}>
              Restart
            </Button>
            <Button type="button" onClick={() => refreshFrame(frame.id)}>
              Refresh
            </Button>
          </div>
        </>
      )}
    </Box>
  )
}

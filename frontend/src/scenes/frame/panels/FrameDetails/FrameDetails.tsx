import { useValues } from 'kea'
import clsx from 'clsx'
import { frameStatus, frameUrl } from '../../../../decorators/frame'
import { Reveal } from '../../../../components/Reveal'
import { frameLogic } from '../../frameLogic'

export interface DetailsProps {
  className?: string
  id: number
}

export function FrameDetails({ className }: DetailsProps) {
  const { frameId, frame } = useValues(frameLogic)

  return (
    <div className={clsx('space-y-4', className)}>
      {!frame ? (
        `Loading frame ${frameId}...`
      ) : (
        <>
          <table className="table-auto border-separate border-spacing-x-1 border-spacing-y-0.5">
            <tbody>
              <tr>
                <td className="text-blue-200 text-right">Name:</td>
                <td>{frame.name}</td>
              </tr>
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
                  {frame.device} {frame.width && frame.height ? `${frame.width}x${frame.height}` : ''} {frame.color}
                </td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Refresh interval:</td>
                <td className="truncate">{frame.interval} seconds</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Metric reporting interval:</td>
                <td className="truncate">{frame.metrics_interval} seconds</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Scaling mode:</td>
                <td className="truncate">{frame.scaling_mode}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Rotate:</td>
                <td className="truncate">{frame.rotate}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Background color:</td>
                <td className="truncate">{frame.background_color}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Frame URL:</td>
                <td className="truncate">
                  <a href={frameUrl(frame)} target="_blank" rel="noreferer noopener">
                    {frameUrl(frame)}
                  </a>
                </td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

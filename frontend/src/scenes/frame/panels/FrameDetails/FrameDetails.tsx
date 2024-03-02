import { useValues } from 'kea'
import clsx from 'clsx'
import { frameControlUrl, frameStatus, frameUrl } from '../../../../decorators/frame'
import { Reveal } from '../../../../components/Reveal'
import { frameLogic } from '../../frameLogic'
import { Tooltip } from '../../../../components/Tooltip'

export interface DetailsProps {
  className?: string
  id: number
}

export function FrameDetails({ className }: DetailsProps) {
  const { frameId, frame } = useValues(frameLogic)
  const url = frameUrl(frame)
  const controlUrl = frameControlUrl(frame)

  return (
    <div className={clsx('space-y-4 w-full', className)}>
      {!frame ? (
        `Loading frame ${frameId}...`
      ) : (
        <>
          <table className="w-full border-separate border-spacing-x-1 border-spacing-y-0.5">
            <tbody>
              <tr>
                <td className="text-blue-200 text-right max-w-[200px]">Name:</td>
                <td className="break-words">{frame.name}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Frame URL:</td>
                <td className="truncate max-w-0">
                  {url ? (
                    <a href={url} target="_blank" rel="noreferer noopener">
                      {url}
                    </a>
                  ) : (
                    'N/A'
                  )}
                </td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Control URL:</td>
                <td className="truncate max-w-0">
                  {controlUrl ? (
                    <a href={controlUrl} target="_blank" rel="noreferer noopener">
                      {controlUrl}
                    </a>
                  ) : (
                    'N/A'
                  )}
                </td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Frame host:</td>
                <td className="break-words">{frame.frame_host}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Frame port:</td>
                <td className="break-words">{frame.frame_port}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Frame access:</td>
                <td className="break-words flex gap-1 items-center">
                  {frame.frame_access}
                  <Tooltip
                    title={
                      frame.frame_access === 'public'
                        ? 'Can view and edit without an access key'
                        : frame.frame_access === 'protected'
                        ? 'Can view without an access key, but requires an access key to edit'
                        : frame.frame_access === 'private'
                        ? 'Requires an access key to view and edit'
                        : 'Unknown access type'
                    }
                  />
                </td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Frame access key:</td>
                <td className="break-all">
                  <Reveal>{frame.frame_access_key}</Reveal>
                </td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">SSH user:</td>
                <td className="break-words">{frame.ssh_user}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">SSH pass:</td>
                <td className="break-all">
                  <Reveal>{frame.ssh_pass}</Reveal>
                </td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">SSH port:</td>
                <td className="break-words">{frame.ssh_port}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Controller host:</td>
                <td className="break-words">{frame.server_host}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Controller port:</td>
                <td className="break-words">{frame.server_port}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Controller API key:</td>
                <td className="break-all">
                  <Reveal>{frame.server_api_key}</Reveal>
                </td>
              </tr>
              {frame.version ? (
                <tr>
                  <td className="text-blue-200 text-right">Client version:</td>
                  <td className="break-words">{frame.version}</td>
                </tr>
              ) : null}
              <tr>
                <td className="text-blue-200 text-right">Status:</td>
                <td className="break-words">{frameStatus(frame)}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Device:</td>
                <td className="break-words">
                  {frame.device} {frame.width && frame.height ? `${frame.width}x${frame.height}` : ''} {frame.color}
                </td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Default refresh interval:</td>
                <td className="break-words">{frame.interval} seconds</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right max-w-1">Metric reporting interval:</td>
                <td className="break-words">{frame.metrics_interval} seconds</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Scaling mode:</td>
                <td className="break-words">{frame.scaling_mode}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Rotate:</td>
                <td className="break-words">{frame.rotate}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Debug logging:</td>
                <td className="break-words">{frame.debug ? 'enabled' : 'disabled'}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

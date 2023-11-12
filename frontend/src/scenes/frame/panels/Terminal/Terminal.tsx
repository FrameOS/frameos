import { H6 } from '../../../../components/H6'
import { useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { Reveal } from '../../../../components/Reveal'

export function Terminal() {
  const { frame } = useValues(frameLogic)
  return (
    <div className="space-y-2">
      <H6>TODO: implement inline terminal :/</H6>
      <ul>
        <li>
          <code>
            ssh {frame.ssh_user}@{frame.frame_host}
          </code>
        </li>
        {frame.ssh_pass ? (
          <li className="flex items-center gap-2">
            Password:
            <Reveal>
              <code>{frame.ssh_pass}</code>
            </Reveal>
          </li>
        ) : null}
      </ul>
    </div>
  )
}

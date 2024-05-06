import { H6 } from '../../../../components/H6'
import { useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { Reveal } from '../../../../components/Reveal'
import copy from 'copy-to-clipboard'
import { ClipboardDocumentIcon } from '@heroicons/react/24/solid'

export function Terminal() {
  const { frame } = useValues(frameLogic)
  const sshString = `ssh ${frame.ssh_user}@${frame.frame_host}`
  return (
    <div className="space-y-2">
      <H6>TODO: implement inline terminal :/</H6>
      <ul>
        <li className="space-x-2">
          <code>{sshString}</code>
          <ClipboardDocumentIcon
            className="w-4 h-4 min-w-4 min-h-4 cursor-pointer inline-block"
            onClick={() => copy(sshString)}
          />
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

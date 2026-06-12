import { useActions, useValues } from 'kea'

import { Button } from '../../../../components/Button'
import { Label } from '../../../../components/Label'
import { TextInput } from '../../../../components/TextInput'
import type { FrameType } from '../../../../types'
import { frameDeviceAdminLogic } from './frameDeviceAdminLogic'

/** Rendered only inside the on-device admin: lets a standalone frame adopt
 * itself into a backend with an adoption code, and lets a connected frame
 * request FrameOS/agent updates from its backend. */
export function DeviceBackendPanel({ frame }: { frame: FrameType }): JSX.Element {
  const logicProps = { frameId: frame.id }
  const {
    adoptCode,
    adoptError,
    adoptInProgress,
    adoptMessage,
    adoptServerHost,
    adoptServerPort,
    updateError,
    updateInProgress,
    updateMessage,
  } = useValues(frameDeviceAdminLogic(logicProps))
  const { adoptFrame, requestUpdate, setAdoptCode, setAdoptServerHost, setAdoptServerPort } = useActions(
    frameDeviceAdminLogic(logicProps)
  )

  const connected = !!(frame.server_host && frame.server_api_key)
  const backendLabel = `${frame.server_host}:${frame.server_port || 8989}`

  return (
    <div className="space-y-4">
      {connected ? (
        <div className="space-y-2">
          <div className="text-sm">
            Connected to backend <span className="font-semibold">{backendLabel}</span>
            {frame.version ? <span className="text-gray-500"> · FrameOS {frame.version}</span> : null}
          </div>
          <div className="text-xs text-gray-500">
            Updates are built and deployed by the backend; each one creates a new release on this frame and can be
            rolled back from the backend.
          </div>
          <div className="flex flex-wrap gap-2">
            <Button color="secondary" size="small" disabled={updateInProgress} onClick={() => requestUpdate('frameos')}>
              Update FrameOS from backend
            </Button>
            <Button color="secondary" size="small" disabled={updateInProgress} onClick={() => requestUpdate('agent')}>
              Update agent from backend
            </Button>
          </div>
          {updateMessage ? <div className="text-sm text-emerald-600">{updateMessage}</div> : null}
          {updateError ? <div className="text-sm text-red-500">{updateError}</div> : null}
        </div>
      ) : (
        <div className="text-sm text-gray-500">
          This frame runs standalone. Connect it to a FrameOS backend to manage scenes and install updates.
        </div>
      )}

      <div className="space-y-2">
        <Label>{connected ? 'Connect to a different backend' : 'Connect to a backend'}</Label>
        <div className="text-xs text-gray-500">
          In the backend, choose &quot;Add frame&quot; &rarr; &quot;Adopt existing device&quot; to get an adoption code,
          then enter the backend address and the code here.
        </div>
        <div className="flex flex-col gap-2 @md:flex-row">
          <TextInput
            value={adoptServerHost}
            onChange={setAdoptServerHost}
            placeholder="backend.example.com"
            autoComplete="off"
          />
          <TextInput value={adoptServerPort} onChange={setAdoptServerPort} placeholder="8989" autoComplete="off" />
          <TextInput value={adoptCode} onChange={setAdoptCode} placeholder="Adoption code" autoComplete="off" />
          <Button
            color="primary"
            size="small"
            disabled={adoptInProgress || !adoptServerHost.trim() || !adoptCode.trim()}
            onClick={() => adoptFrame(adoptServerHost.trim(), parseInt(adoptServerPort, 10) || 8989, adoptCode.trim())}
          >
            Connect
          </Button>
        </div>
        {adoptMessage ? <div className="text-sm text-emerald-600">{adoptMessage}</div> : null}
        {adoptError ? <div className="text-sm text-red-500">{adoptError}</div> : null}
      </div>
    </div>
  )
}

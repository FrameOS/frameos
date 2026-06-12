import { actions, kea, key, listeners, path, props, reducers } from 'kea'

import { framesModel } from '../../../../models/framesModel'
import { apiFetch } from '../../../../utils/apiFetch'

import type { frameDeviceAdminLogicType } from './frameDeviceAdminLogicType'

export interface FrameDeviceAdminLogicProps {
  frameId: number
}

/** Actions the on-device admin can take against its backend: adopting a
 * standalone frame into a backend, and requesting FrameOS/agent updates. */
export const frameDeviceAdminLogic = kea<frameDeviceAdminLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'FrameSettings', 'frameDeviceAdminLogic']),
  props({} as FrameDeviceAdminLogicProps),
  key((props) => props.frameId),
  actions({
    setAdoptServerHost: (serverHost: string) => ({ serverHost }),
    setAdoptServerPort: (serverPort: string) => ({ serverPort }),
    setAdoptCode: (code: string) => ({ code }),
    adoptFrame: (serverHost: string, serverPort: number, code: string) => ({ serverHost, serverPort, code }),
    adoptFrameResult: (message: string | null, error: string | null) => ({ message, error }),
    requestUpdate: (target: 'frameos' | 'agent') => ({ target }),
    requestUpdateResult: (message: string | null, error: string | null) => ({ message, error }),
  }),
  reducers({
    adoptServerHost: ['', { setAdoptServerHost: (_, { serverHost }) => serverHost }],
    adoptServerPort: ['8989', { setAdoptServerPort: (_, { serverPort }) => serverPort }],
    adoptCode: ['', { setAdoptCode: (_, { code }) => code }],
    adoptInProgress: [false, { adoptFrame: () => true, adoptFrameResult: () => false }],
    adoptMessage: [null as string | null, { adoptFrame: () => null, adoptFrameResult: (_, { message }) => message }],
    adoptError: [null as string | null, { adoptFrame: () => null, adoptFrameResult: (_, { error }) => error }],
    updateInProgress: [false, { requestUpdate: () => true, requestUpdateResult: () => false }],
    updateMessage: [
      null as string | null,
      { requestUpdate: () => null, requestUpdateResult: (_, { message }) => message },
    ],
    updateError: [null as string | null, { requestUpdate: () => null, requestUpdateResult: (_, { error }) => error }],
  }),
  listeners(({ actions, props }) => ({
    adoptFrame: async ({ serverHost, serverPort, code }) => {
      try {
        const response = await apiFetch(`/api/frames/${props.frameId}/adopt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverHost, serverPort, code }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          actions.adoptFrameResult(null, data?.detail || 'Failed to connect to the backend')
          return
        }
        actions.adoptFrameResult(`Connected to backend ${data?.backend ?? `${serverHost}:${serverPort}`}`, null)
        window.setTimeout(() => framesModel.actions.loadFrame(props.frameId), 1500)
      } catch (error) {
        actions.adoptFrameResult(null, error instanceof Error ? error.message : 'Failed to connect to the backend')
      }
    },
    requestUpdate: async ({ target }) => {
      try {
        const response = await apiFetch(`/api/frames/${props.frameId}/request_update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          actions.requestUpdateResult(null, data?.detail || 'Failed to request an update')
          return
        }
        actions.requestUpdateResult(
          target === 'agent'
            ? 'Agent update queued on the backend. It will be deployed shortly.'
            : 'FrameOS update queued on the backend. A new release will be deployed shortly.',
          null
        )
      } catch (error) {
        actions.requestUpdateResult(null, error instanceof Error ? error.message : 'Failed to request an update')
      }
    },
  })),
])

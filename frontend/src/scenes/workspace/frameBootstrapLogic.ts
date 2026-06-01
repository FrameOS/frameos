import { actions, kea, key, listeners, path, props, reducers } from 'kea'
import copy from 'copy-to-clipboard'

import { framesModel } from '../../models/framesModel'
import { apiFetch } from '../../utils/apiFetch'
import { cachedProjectId } from '../../utils/projectApi'
import { showSuccessMessage } from '../../utils/workingMessage'

import type { frameBootstrapLogicType } from './frameBootstrapLogicType'

export interface FrameBootstrapLogicProps {
  frameId: number
}

interface FrameBootstrapApiResponse {
  command: string
  script_url: string
}

function redactedFrameBootstrapUrl(scriptUrl: string, frameId: number): string {
  const projectId = cachedProjectId()
  const frameBootstrapPath = projectId
    ? `/api/projects/${projectId}/frame-bootstrap/${frameId}`
    : `/api/frame-bootstrap/${frameId}`

  try {
    const url = new URL(scriptUrl)
    const projectScopedMatch = url.pathname.match(new RegExp(`^(.*/api/projects/\\d+/frame-bootstrap/${frameId})(?:/|$)`))
    if (projectScopedMatch) {
      return `${url.origin}${projectScopedMatch[1]}/[secret]`
    }

    const pathStart = url.pathname.indexOf(frameBootstrapPath)
    const pathPrefix =
      pathStart === -1 ? frameBootstrapPath : url.pathname.slice(0, pathStart + frameBootstrapPath.length)

    return `${url.origin}${pathPrefix}/[secret]`
  } catch {
    return `${frameBootstrapPath}/[secret]`
  }
}

function frameBootstrapCommandPreview(scriptUrl: string, frameId: number): string {
  const command = `curl -fsSL ${redactedFrameBootstrapUrl(scriptUrl, frameId)} | sudo sh`
  const maxLength = 140

  return command.length > maxLength ? `${command.slice(0, maxLength - 3)}...` : command
}

export const frameBootstrapLogic = kea<frameBootstrapLogicType>([
  path(['src', 'scenes', 'workspace', 'frameBootstrapLogic']),
  props({} as FrameBootstrapLogicProps),
  key((props) => props.frameId),
  actions({
    copyFrameBootstrapScript: (selectAgent = true) => ({ selectAgent }),
    copyFrameBootstrapScriptSuccess: true,
    copyFrameBootstrapScriptFailure: (error: string) => ({ error }),
    resetFrameBootstrapScriptState: true,
  }),
  reducers({
    loading: [
      false,
      {
        copyFrameBootstrapScript: () => true,
        copyFrameBootstrapScriptSuccess: () => false,
        copyFrameBootstrapScriptFailure: () => false,
      },
    ],
    copied: [
      false,
      {
        copyFrameBootstrapScript: () => false,
        copyFrameBootstrapScriptSuccess: () => true,
        copyFrameBootstrapScriptFailure: () => false,
        resetFrameBootstrapScriptState: () => false,
      },
    ],
    error: [
      null as string | null,
      {
        copyFrameBootstrapScript: () => null,
        copyFrameBootstrapScriptSuccess: () => null,
        copyFrameBootstrapScriptFailure: (_, { error }) => error,
        resetFrameBootstrapScriptState: () => null,
      },
    ],
  }),
  listeners(({ actions, props }) => ({
    copyFrameBootstrapScript: async ({ selectAgent }) => {
      const response = await apiFetch(
        `/api/frames/${props.frameId}/frame_bootstrap?select_agent=${selectAgent ? 1 : 0}`,
        {
          method: 'POST',
        }
      )
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        actions.copyFrameBootstrapScriptFailure(
          typeof payload?.detail === 'string' ? payload.detail : 'Failed to create FrameOS bootstrap script'
        )
        return
      }

      const payload = (await response.json()) as FrameBootstrapApiResponse
      copy(payload.command)
      actions.copyFrameBootstrapScriptSuccess()
      showSuccessMessage(`Copied: ${frameBootstrapCommandPreview(payload.script_url, props.frameId)}`)
      framesModel.actions.loadFrame(props.frameId)
    },
  })),
])

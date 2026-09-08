import { useActions, useValues } from 'kea'
import { useEffect, useState } from 'react'

import { Button } from '../../../../components/Button'
import { Checkbox } from '../../../../components/Checkbox'
import { Modal } from '../../../../components/Modal'
import { settingsDetails } from '../secretSettings'
import { previewKeyConsentLogic } from './previewKeyConsentLogic'

/**
 * "This scene from the store would get your OpenAI and Unsplash keys in the
 * preview" — mounted once by App; previewKeyConsentLogic parks the request.
 */
export function PreviewKeyConsentModal(): JSX.Element | null {
  const { pending } = useValues(previewKeyConsentLogic)
  const { answer, cancel, hostMounted, hostUnmounted } = useActions(previewKeyConsentLogic)
  const [remember, setRemember] = useState<Record<string, boolean>>({})

  useEffect(() => {
    hostMounted()
    return () => hostUnmounted()
  }, [hostMounted, hostUnmounted])

  useEffect(() => {
    setRemember({})
  }, [pending])

  if (!pending) {
    return null
  }

  const remembered = pending.groups.filter((group) => remember[group])
  const sceneList = pending.sceneNames.map((name) => `"${name}"`).join(', ')
  const groupTitle = (group: string): string => settingsDetails[group]?.title ?? group

  return (
    <Modal
      title="Preview with your API keys?"
      onClose={cancel}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="small" color="secondary" onClick={cancel}>
            Cancel
          </Button>
          <Button size="small" color="secondary" onClick={() => answer('deny', remembered)}>
            Preview without keys
          </Button>
          <Button size="small" color="primary" onClick={() => answer('allow', remembered)}>
            Preview with keys
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-5">
        <p className="frameos-strong text-sm">
          {pending.sceneNames.length === 1 ? 'Scene' : 'Scenes'} {sceneList}{' '}
          {pending.sceneNames.length === 1 ? 'comes' : 'come'} from the scene store. Previewing in the browser runs that
          code with your keys for: <strong>{pending.groups.map(groupTitle).join(', ')}</strong>.
        </p>
        <p className="frameos-muted text-sm">
          Scenes you wrote yourself never ask. Without keys, the apps that need them show their error state instead of
          calling out. Either answer can be remembered per key; forget them under Settings.
        </p>
        <div className="space-y-2">
          {pending.groups.map((group) => (
            <Checkbox
              key={group}
              value={Boolean(remember[group])}
              onChange={(value) => setRemember((state) => ({ ...state, [group]: value }))}
              label={`Remember this decision for all previews using ${groupTitle(group)} keys`}
            />
          ))}
        </div>
      </div>
    </Modal>
  )
}

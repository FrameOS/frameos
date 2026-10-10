import { useActions, useValues } from 'kea'
import { Button } from '../../../../components/Button'
import { Modal } from '../../../../components/Modal'
import { TextInput } from '../../../../components/TextInput'
import { MIN_SLIDESHOW_SECONDS, slideshowSettingsLogic } from './slideshowSettingsLogic'

/** "Default slideshow settings" from the Assets panel's menu. */
export function SlideshowSettingsModal(): JSX.Element | null {
  const { settingsOpen, secondsBetweenImages, draftSeconds, draftIsValid } = useValues(slideshowSettingsLogic)
  const { closeSettings, setDraftSeconds, saveSettings } = useActions(slideshowSettingsLogic)
  if (!settingsOpen) {
    return null
  }
  const value = draftSeconds === null && secondsBetweenImages ? String(secondsBetweenImages) : ''
  return (
    <Modal
      title="Default slideshow settings"
      onClose={closeSettings}
      panelClassName="max-w-md"
      footer={
        <div className="frameos-divider flex items-center justify-end gap-2 border-t p-4">
          <Button color="secondary" size="small" onClick={closeSettings}>
            Cancel
          </Button>
          <Button
            color="primary"
            size="small"
            onClick={() => saveSettings(draftSeconds ?? secondsBetweenImages)}
            disabled={draftSeconds !== null && !draftIsValid}
          >
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3 p-4">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Seconds between images</span>
          <TextInput
            type="number"
            min={MIN_SLIDESHOW_SECONDS}
            step={1}
            value={draftSeconds === null ? value : String(draftSeconds)}
            onChange={(next) => {
              const parsed = Number.parseFloat(next)
              setDraftSeconds(Number.isFinite(parsed) ? parsed : null)
            }}
          />
        </label>
        <p className="frameos-muted text-xs">
          Used by "Start slideshow" on a folder. The scene it creates still has its own setting, so an existing
          slideshow keeps the seconds it was made with. At least {MIN_SLIDESHOW_SECONDS} seconds; an e-paper panel needs
          a while to refresh.
        </p>
      </div>
    </Modal>
  )
}

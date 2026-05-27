import { CheckIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { Button } from '../../../components/Button'
import { H6 } from '../../../components/H6'
import { Modal } from '../../../components/Modal'
import { SecretField } from '../../../components/SecretField'
import { TextInput } from '../../../components/TextInput'
import clsx from 'clsx'
import { FrameOSSettings } from '../../../types'
import { urls } from '../../../urls'
import { getSettingsValue, settingsDetails } from './secretSettings'

interface SecretSettingsModalProps {
  activeSettingsKey: string | null
  onClose: () => void
  settings: FrameOSSettings | null
  savedSettings: FrameOSSettings | null
  settingsChanged: boolean
  setSettingsValue: (path: (keyof FrameOSSettings | string)[], value: string) => void
  submitSettings: () => void
}

export function SecretSettingsModal({
  activeSettingsKey,
  onClose,
  settings,
  savedSettings,
  settingsChanged,
  setSettingsValue,
  submitSettings,
}: SecretSettingsModalProps): JSX.Element | null {
  const activeSettings = activeSettingsKey ? settingsDetails[activeSettingsKey] : null

  if (!activeSettings) {
    return null
  }

  return (
    <Modal title={`Global setting: ${activeSettings.title}`} onClose={onClose}>
      <div className="space-y-4 p-5">
        <div className="rounded-xl border border-orange-400/35 bg-orange-500/10 p-3">
          <div className="text-xs font-semibold uppercase text-orange-500">Global setting</div>
          <div className="frameos-strong text-sm">
            Changing this will affect all frames. Redeploy to update the persisted value.
          </div>
        </div>
        {activeSettings.description ? <p className="frameos-muted text-sm">{activeSettings.description}</p> : null}
        <div className="space-y-2">
          <H6 className="text-base">{activeSettings.title}</H6>
          <div className="space-y-3">
            {activeSettings.fields.map((field) => {
              const value = getSettingsValue(settings, field.path)
              const hasValue =
                value !== undefined && value !== null && (typeof value === 'string' ? value.trim() !== '' : true)
              const savedValue = getSettingsValue(savedSettings, field.path)
              const isSaved =
                savedValue !== undefined &&
                savedValue !== null &&
                (typeof savedValue === 'string' ? savedValue.trim() !== '' : true)

              return (
                <div
                  key={field.label}
                  className="frameos-inset flex items-start gap-3 rounded-xl border px-3 py-3 text-sm"
                >
                  <div
                    className={clsx(
                      'mt-0.5 flex h-6 w-6 items-center justify-center rounded border',
                      hasValue ? 'border-emerald-400 bg-emerald-500' : 'border-yellow-400 bg-yellow-500/20'
                    )}
                  >
                    {hasValue ? (
                      <CheckIcon className="h-4 w-4 text-emerald-950" />
                    ) : (
                      <ExclamationTriangleIcon className="h-4 w-4 text-yellow-300" />
                    )}
                  </div>
                  <div className="flex-1 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="frameos-strong">{field.label}</span>
                      <div className="flex items-center gap-2">
                        {!isSaved ? (
                          <span className="frameos-tag px-2 py-0.5 text-xs font-semibold uppercase" data-tag-color="yellow">
                            Missing
                          </span>
                        ) : (
                          <span className="frameos-tag px-2 py-0.5 text-xs font-semibold uppercase" data-tag-color="teal">
                            Saved
                          </span>
                        )}
                        {field.secret ? (
                          <span className="frameos-tag px-2 py-0.5 text-xs font-semibold uppercase" data-tag-color="orange">
                            Secret
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <SecretField value={value ?? ''}>
                      <TextInput
                        value={value ?? ''}
                        onChange={(nextValue) => setSettingsValue(field.path, nextValue)}
                        autoFocus
                      />
                    </SecretField>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="small" color={settingsChanged ? 'primary' : 'secondary'} onClick={submitSettings}>
            Save global settings
          </Button>
          <Button size="small" color="secondary" onClick={() => (window.location.href = urls.settings())}>
            Open global settings
          </Button>
        </div>
      </div>
    </Modal>
  )
}

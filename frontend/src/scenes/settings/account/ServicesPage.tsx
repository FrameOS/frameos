import { useActions, useValues } from 'kea'
import { useEffect } from 'react'

import { Button } from '../../../components/Button'
import { Spinner } from '../../../components/Spinner'
import { ServicesSettingsForm } from '../ServicesSettingsForm'
import { settingsLogic } from '../settingsLogic'
import { scrollToSettingsSection } from '../settingsScroll'
import { AccountPageHeader } from './AccountPageHeader'

// The service API keys: the same form the self-hosted settings page draws
// (ServicesSettingsForm over settingsLogic and the cloud's /api/settings),
// with the page's Save and Reset in the header. A deep link
// (/settings/services#settings-openai, which the scene editors use) scrolls
// to its section once the form has loaded.
export function ServicesPage(): JSX.Element {
  const { savedSettings, savedSettingsLoading, settingsChanged, isSettingsSubmitting } = useValues(settingsLogic)
  const { submitSettings, resetSettings } = useActions(settingsLogic)

  useEffect(() => {
    if (savedSettingsLoading || typeof window === 'undefined') {
      return
    }
    const hash = window.location.hash
    if (hash.startsWith('#settings-')) {
      scrollToSettingsSection(hash.slice(1))
    }
  }, [savedSettingsLoading])

  return (
    <div>
      <AccountPageHeader
        page="services"
        actions={
          <>
            <Button
              size="small"
              color="secondary"
              onClick={() => resetSettings(savedSettings)}
              disabled={!settingsChanged || isSettingsSubmitting}
              className="rounded-lg px-4 py-2"
            >
              Reset
            </Button>
            <Button
              size="small"
              color={settingsChanged ? 'primary' : 'secondary'}
              onClick={submitSettings}
              disabled={!settingsChanged || isSettingsSubmitting}
              className="rounded-lg px-4 py-2"
            >
              Save
            </Button>
          </>
        }
      />
      {savedSettingsLoading ? <Spinner /> : <ServicesSettingsForm divider={false} />}
    </div>
  )
}

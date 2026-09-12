import { ArrowRightStartOnRectangleIcon } from '@heroicons/react/24/outline'
import { useValues } from 'kea'

import { Button } from '../../../../components/Button'
import { isInFrameAdminMode } from '../../../../utils/frameAdmin'
import { cloudLogic } from '../../../settings/cloudLogic'
import { FrameActionsMenu } from './FrameActionsMenu'
import { useFrameSettings } from './frameSettingsContext'

/**
 * The actions at the top right of the Settings panel.
 *
 * On a backend that owns the frame this is just the "…" frame menu, next to
 * the first heading as before. On the frame's own admin panel the page is the
 * whole app, so it also carries "Log out" — and the first heading there is
 * "FrameOS Cloud", not "Frame info".
 *
 * Both places therefore render this with the slot they are, and exactly one of
 * them draws anything: `cloud` when the cloud section has a heading to hang
 * them on, `fallback` when it does not (FRAMEOS_CLOUD_URL=disabled).
 */
export function SettingsHeaderActions({ slot }: { slot: 'cloud' | 'fallback' }): JSX.Element | null {
  // Not a hook: the mode is fixed for the life of the page, so the branch
  // below never flips between renders. Keeping it out of the frame-admin
  // component is what stops a backend's Settings panel from mounting
  // cloudLogic (and polling /api/cloud/status) for a section it never draws.
  if (!isInFrameAdminMode()) {
    return slot === 'fallback' ? <FrameActionsMenu /> : null
  }
  return <FrameAdminHeaderActions slot={slot} />
}

function FrameAdminHeaderActions({ slot }: { slot: 'cloud' | 'fallback' }): JSX.Element | null {
  const { frame } = useFrameSettings()
  const { cloudStatus } = useValues(cloudLogic)
  // Unknown yet (the status is still loading) counts as visible: the cloud
  // heading is the usual home, and claiming the fallback first would move the
  // buttons across the page a moment later.
  const cloudHeadingVisible = cloudStatus?.enabled !== false
  if (slot === 'cloud' ? !cloudHeadingVisible : cloudHeadingVisible) {
    return null
  }
  return (
    <div className="flex items-center gap-2">
      {frame.frame_admin_auth?.enabled ? <FrameAdminLogoutButton /> : null}
      <FrameActionsMenu />
    </div>
  )
}

/** GET /logout clears the admin session cookie and lands on /login. It ends a
 * cloud sign-in the same way it ends a password one. */
function FrameAdminLogoutButton(): JSX.Element {
  return (
    <Button
      size="small"
      color="secondary"
      onClick={() => {
        window.location.href = '/logout'
      }}
      className="inline-flex items-center gap-1.5"
    >
      <ArrowRightStartOnRectangleIcon className="h-4 w-4" />
      Log out
    </Button>
  )
}

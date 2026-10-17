// The frame's LAN access switch: copy and names shared by the settings
// section (lanAccessLogic), the Add frame forms on both planes and the Logs
// panel. No imports, so the cloud's setup forms can use it without the SPA's
// models.

export const LAN_ACCESS_HELP =
  'Lets scenes reach devices on your home network, like Home Assistant or a NAS. When off, requests to local ' +
  'addresses are blocked. Keep devices the frame should not reach on a separate network as well.'

/** How every device-side "blocked" error starts (Pi and ESP32 alike). */
export const LAN_ACCESS_BLOCKED_LOG_PREFIX = 'LAN access is off for this frame'

/** The settings section's heading id, which the Logs panel links to. */
export const LAN_ACCESS_SETTINGS_ANCHOR = 'frame-settings-lan-access'

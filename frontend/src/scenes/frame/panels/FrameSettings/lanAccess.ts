// The frame's local network access switch: copy and names shared by the settings
// section (lanAccessLogic) and the Logs panel. No imports.

export const LAN_ACCESS_HELP =
  'Lets scenes reach devices on your home network, like Home Assistant or a NAS. When off, requests to local ' +
  'addresses are blocked. Remember, security is layered: for true isolation, still manage access at the network ' +
  'level.'

/** How every device-side "blocked" error starts (Pi and ESP32 alike). */
export const LAN_ACCESS_BLOCKED_LOG_PREFIX = 'Local network access is off for this frame'

/** The settings section's heading id, which the Logs panel links to. */
export const LAN_ACCESS_SETTINGS_ANCHOR = 'frame-settings-lan-access'

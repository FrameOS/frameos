// "Remember WiFi" for the add-frame flows (SD image builder and ESP32
// flasher): one stored network, shared between both, kept in this browser's
// localStorage only — credentials never reach the server either way.
//
// Only the network NAME is remembered. The passphrase used to be stored
// beside it in plaintext localStorage, readable by any script on the origin
// and by anyone at the keyboard; it is retyped now (the form says so).

const wifiStorageKey = 'frameos-sd-image-wifi'

export function loadRememberedWifi(): { password: string; ssid: string } | undefined {
  try {
    const raw = localStorage.getItem(wifiStorageKey)
    if (!raw) {
      return undefined
    }
    const parsed = JSON.parse(raw) as { password?: unknown; ssid?: unknown }
    if (typeof parsed.ssid !== 'string' || !parsed.ssid) {
      return undefined
    }
    // A value written by the older code carries the passphrase: drop it now.
    if (typeof parsed.password === 'string' && parsed.password) {
      storeRememberedWifi(parsed.ssid, '')
    }
    return { password: '', ssid: parsed.ssid }
  } catch {
    return undefined
  }
}

export function storeRememberedWifi(ssid: string, _password: string): void {
  try {
    localStorage.setItem(wifiStorageKey, JSON.stringify({ ssid }))
  } catch {
    // Storage full or blocked — remembering is best-effort.
  }
}

export function clearRememberedWifi(): void {
  try {
    localStorage.removeItem(wifiStorageKey)
  } catch {
    // Ditto.
  }
}

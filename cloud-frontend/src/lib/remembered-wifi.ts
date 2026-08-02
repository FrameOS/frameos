// "Remember WiFi" for the add-frame flows (SD image builder and ESP32
// flasher): one stored network, shared between both, kept in this browser's
// localStorage only — credentials never reach the server either way.

const wifiStorageKey = 'frameos-sd-image-wifi'

export function loadRememberedWifi(): { password: string; ssid: string } | undefined {
  try {
    const raw = localStorage.getItem(wifiStorageKey)
    if (!raw) {
      return undefined
    }
    const parsed = JSON.parse(raw) as { password?: unknown; ssid?: unknown }
    if (typeof parsed.ssid !== 'string' || typeof parsed.password !== 'string') {
      return undefined
    }
    return { password: parsed.password, ssid: parsed.ssid }
  } catch {
    return undefined
  }
}

export function storeRememberedWifi(ssid: string, password: string): void {
  try {
    localStorage.setItem(wifiStorageKey, JSON.stringify({ password, ssid }))
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

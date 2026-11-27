// The GPIO buttons a device always has, by device id: an Inky Impression's
// A–D (the 13" has C on another pin). Pure data, import-free beyond the type
// barrel, so the "Map buttons" helpers (utils/sceneEventMap.ts) and the cloud's
// node test suite can read it without the settings panel behind it.
import type { GPIOButton } from '../types'

// A is Action, B and C point up and down (they turn with the frame), D is Back
// (docs/buttons.md). Keep in step with backend/app/drivers/devices.py.
export const INKY_GPIO_BUTTONS: GPIOButton[] = [
  { pin: 5, label: 'A', role: 'primary' },
  { pin: 6, label: 'B', role: 'up' },
  { pin: 16, label: 'C', role: 'down' },
  { pin: 24, label: 'D', role: 'back' },
]
export const INKY_13_GPIO_BUTTONS: GPIOButton[] = [
  { pin: 5, label: 'A', role: 'primary' },
  { pin: 6, label: 'B', role: 'up' },
  { pin: 25, label: 'C', role: 'down' },
  { pin: 24, label: 'D', role: 'back' },
]
export const INKY_AUTO_BUTTON_DEVICES = new Set([
  'pimoroni.inky_impression',
  'pimoroni.inky_impression_7_3',
  'pimoroni.inky_impression_7_color',
  'pimoroni.inky_impression_5_7',
  'pimoroni.inky_impression_5_7_color',
  'pimoroni.inky_impression_4_7_color',
  'pimoroni.inky_impression_4',
  'pimoroni.inky_impression_4_2025',
  'pimoroni.inky_impression_4_spectra6',
  'pimoroni.inky_impression_7',
  'pimoroni.inky_impression_7_2025',
  'pimoroni.inky_impression_13',
  'pimoroni.inky_impression_13_2025',
])
export const INKY_13_AUTO_BUTTON_DEVICES = new Set(['pimoroni.inky_impression_13', 'pimoroni.inky_impression_13_2025'])

export function configuredGpioButtonsForDevice(device?: string | null): GPIOButton[] | null {
  if (!device) {
    return null
  }
  if (INKY_13_AUTO_BUTTON_DEVICES.has(device)) {
    return INKY_13_GPIO_BUTTONS
  }
  if (INKY_AUTO_BUTTON_DEVICES.has(device)) {
    return INKY_GPIO_BUTTONS
  }
  return null
}

// A scene's own window size on a desktop (`settings.windowSize`,
// docs/scene-layouts.md "Windows"): "WxH" in the desktop's pixels. A desktop
// opens a new window of the scene at that size where it fits; without one, at
// 800 x 480 (a desktop has no window size of its own).

export interface WindowSizeOption {
  value: string
  label: string
}

export const SCENE_WINDOW_SIZE_HELP =
  "The size this scene opens at in a window of a desktop layout (Windows 98, macOS, BeOS, Classic Mac, NeXTSTEP, OS/2 Warp, Omarchy's floating workspaces), 800 × 480 by default. A music player opens square, a to-do list tall. It changes nothing outside a desktop."

const PRESETS: WindowSizeOption[] = [
  { value: '480x480', label: '480 × 480, square' },
  { value: '640x640', label: '640 × 640, square' },
  { value: '800x480', label: '800 × 480, a 7.5-inch frame' },
  { value: '640x480', label: '640 × 480' },
  { value: '800x600', label: '800 × 600' },
  { value: '1024x768', label: '1024 × 768' },
  { value: '1280x720', label: '1280 × 720, wide' },
  { value: '1280x800', label: '1280 × 800' },
  { value: '480x640', label: '480 × 640, tall' },
  { value: '480x800', label: '480 × 800, tall' },
  { value: '600x800', label: '600 × 800, tall' },
]

const MIN_SIDE = 64
const MAX_SIDE = 4096

/** "WxH" as numbers, or null for anything else (each side 64 to 4096). */
export function parseWindowSize(value: unknown): { width: number; height: number } | null {
  if (typeof value !== 'string') {
    return null
  }
  const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(value)
  if (!match) {
    return null
  }
  const width = Number(match[1])
  const height = Number(match[2])
  if (width < MIN_SIDE || height < MIN_SIDE || width > MAX_SIDE || height > MAX_SIDE) {
    return null
  }
  return { width, height }
}

/** A scene's `settings.windowSize` as the select's value: "" for the default, 800 x 480. */
export function sceneWindowSizeSelectValue(value: unknown): string {
  const size = parseWindowSize(value)
  return size ? `${size.width}x${size.height}` : ''
}

/** The select's value as a scene setting: undefined (the key is dropped) for the default. */
export function sceneWindowSizeFromSelect(value: string): string | undefined {
  return sceneWindowSizeSelectValue(value) || undefined
}

/** The choices: the default, the presets, and a size of the scene's own that is not one of them. */
export function sceneWindowSizeOptions(current?: unknown): WindowSizeOption[] {
  const options: WindowSizeOption[] = [{ value: '', label: 'Default, 800 × 480' }, ...PRESETS]
  const own = parseWindowSize(current)
  if (own && !options.some((option) => option.value === `${own.width}x${own.height}`)) {
    options.push({ value: `${own.width}x${own.height}`, label: `${own.width} × ${own.height}` })
  }
  return options
}

// A scene's icon (`settings.icon`, docs/scene-icons.md): ONE SVG path `d`
// string in a 0 0 24 24 box, filled (nonzero) with the color of wherever it
// is shown. The runtime reads it with the same rule (frameos/scene_icon.nim),
// and docs/scene-icon-fixtures.json pins the two together. Anything that is
// not a valid icon is no icon: every surface keeps its own placeholder.

/** The box an icon is drawn in. */
export const SCENE_ICON_VIEWBOX = '0 0 24 24'
export const SCENE_ICON_SIZE = 24
/** It travels to every frame, an ESP32's scene index included: kept short. */
export const SCENE_ICON_MAX_LENGTH = 1024

export const SCENE_ICON_HELP =
  "A small picture of this scene, wherever a list shows it without its picture: the frame's scene list, " +
  'the scene library, desktop layouts. One SVG path in a 24 × 24 box, filled with the color of the text ' +
  'around it, so it works on e-paper and on every theme.'

/** How many numbers each path command takes. */
export const PATH_COMMAND_ARGS: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
}

/** One command of path data as written: its letter (case kept) and every number after it. */
export interface PathDataCommand {
  command: string
  args: number[]
}

// The separators pixie's path reader knows: space, tab, LF, CR and comma.
const ALLOWED = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\- \t\n\r]*$/
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y
const FLAG = /[01]/y
const SEPARATORS = /[ \t\n\r,]*/y

/** `text` without the spaces, tabs and line breaks at its ends (and nothing else String.trim takes). */
function trimPath(text: string): string {
  return text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '')
}

/**
 * Path data read into its commands, or null when SVG would not draw it: a
 * number where none fits, a count of numbers that is not a multiple of what
 * its command takes, an arc flag that is not 0 or 1.
 */
export function parsePathData(d: string): PathDataCommand[] | null {
  const commands: PathDataCommand[] = []
  let current: PathDataCommand | null = null
  let i = 0
  while (i < d.length) {
    SEPARATORS.lastIndex = i
    SEPARATORS.exec(d)
    i = SEPARATORS.lastIndex
    if (i >= d.length) {
      break
    }
    const char = d.charAt(i)
    if (char.toUpperCase() in PATH_COMMAND_ARGS) {
      const command: PathDataCommand = { command: char, args: [] }
      commands.push(command)
      current = command
      i++
      continue
    }
    if (!current) {
      return null
    }
    const upper = current.command.toUpperCase()
    if (PATH_COMMAND_ARGS[upper] === 0) {
      return null
    }
    const position = current.args.length % 7
    const pattern = upper === 'A' && (position === 3 || position === 4) ? FLAG : NUMBER
    pattern.lastIndex = i
    const match = pattern.exec(d)
    if (!match) {
      return null
    }
    const value = Number(match[0])
    if (!Number.isFinite(value)) {
      return null
    }
    current.args.push(value)
    i = pattern.lastIndex
  }
  for (const { command, args } of commands) {
    const count = PATH_COMMAND_ARGS[command.toUpperCase()] ?? 0
    if (count === 0 ? args.length > 0 : args.length === 0 || args.length % count !== 0) {
      return null
    }
  }
  return commands
}

/** Why `value` is not an icon, in a sentence for the editor; null when it is one or there is none. */
export function sceneIconProblem(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null
  }
  if (typeof value !== 'string') {
    return 'An icon is text: one SVG path.'
  }
  const d = trimPath(value)
  if (!d) {
    return null
  }
  if (d.length > SCENE_ICON_MAX_LENGTH) {
    return `This icon is ${d.length} characters long. An icon can be ${SCENE_ICON_MAX_LENGTH} at most: try a simpler one.`
  }
  if (!ALLOWED.test(d)) {
    const other = [...d].find((char) => !ALLOWED.test(char)) ?? ''
    return `An icon holds path commands and numbers only, and "${other}" is neither. Paste the d="..." of one <path>, or upload the SVG.`
  }
  if (d[0] !== 'M' && d[0] !== 'm') {
    return 'An icon starts with M, a move, like M12 2L2 22h20z.'
  }
  if (!parsePathData(d)) {
    return 'SVG cannot draw this path: check the numbers after each command.'
  }
  return null
}

/** `value` as an icon (trimmed), or null for no icon: absent, empty, or anything that is not one. */
export function sceneIconPath(value: unknown): string | null {
  if (typeof value !== 'string' || !trimPath(value) || sceneIconProblem(value) !== null) {
    return null
  }
  return trimPath(value)
}

/** What the text box writes into `settings.icon`: undefined (the key is dropped) when it is empty. */
export function sceneIconFromInput(text: string): string | undefined {
  return trimPath(text) ? text : undefined
}

/** A scene's icon as a list draws it, or null for its own placeholder. */
export function sceneIconOf(scene: { settings?: { icon?: unknown } | null } | null | undefined): string | null {
  return sceneIconPath(scene?.settings?.icon)
}

/** A saved scene's or template's icon: its main scene's (the default, else the first), when it carries its scenes. */
export function templateSceneIcon(template: {
  scenes?: readonly { default?: boolean; settings?: { icon?: unknown } | null }[] | null
}): string | null {
  const scenes = template.scenes ?? []
  return sceneIconOf(scenes.find((scene) => scene.default) ?? scenes[0])
}

// A minimal, dependency-free management interface for a FrameOS preview:
// canvas, scene switcher, showIf-aware state fields, event buttons, and a log
// pane. Mirrors the device's own /control page (frameos/assets/web/control.html)
// but runs entirely in the browser against the wasm runtime.
import { FrameOSPreview, type FrameOSPreviewOptions } from './preview'
import { coerceStateFieldValue, evaluateShowIf, stateFieldShowIfValues } from './showIf'
import { sceneEventButtons, type FrameOSScene, type StateField } from './types'

export interface FrameOSManagerOptions extends Omit<FrameOSPreviewOptions, 'canvas'> {
  /** Show the log pane (default true). */
  showLogs?: boolean
  /** Max log lines kept (default 200). */
  maxLogLines?: number
}

export interface FrameOSManagerHandle {
  preview: FrameOSPreview
  destroy: () => void
}

/**
 * Mount a self-contained preview + control surface into `container`.
 * Returns the underlying FrameOSPreview for programmatic control.
 */
export function mountFrameOSManager(container: HTMLElement, options: FrameOSManagerOptions): FrameOSManagerHandle {
  const showLogs = options.showLogs !== false
  const maxLogLines = options.maxLogLines ?? 200

  container.classList.add('frameos-manager')
  container.innerHTML = ''
  injectStyles()

  const stage = el('div', 'frameos-manager__stage')
  const canvas = document.createElement('canvas')
  canvas.className = 'frameos-manager__canvas'
  canvas.width = options.width
  canvas.height = options.height
  stage.appendChild(canvas)

  const status = el('div', 'frameos-manager__status', 'Loading FrameOS runtime…')
  const controls = el('div', 'frameos-manager__controls')
  const logPane = el('pre', 'frameos-manager__logs')
  logPane.style.display = showLogs ? '' : 'none'

  container.appendChild(stage)
  container.appendChild(status)
  container.appendChild(controls)
  container.appendChild(logPane)

  // Values the user typed, overriding the runtime's reported state until the
  // runtime confirms them via a state message.
  let editedValues: Record<string, unknown> = {}
  let destroyed = false
  const logLines: string[] = []

  const appendLog = (line: string): void => {
    logLines.push(line)
    if (logLines.length > maxLogLines) {
      logLines.splice(0, logLines.length - maxLogLines)
    }
    logPane.textContent = logLines.join('\n')
    logPane.scrollTop = logPane.scrollHeight
  }

  const sceneById = new Map<string, FrameOSScene>()
  for (const scene of options.scenes) {
    sceneById.set(scene.id, scene)
  }

  const preview = new FrameOSPreview({
    ...options,
    canvas,
    onReady: (sceneInfo) => {
      status.textContent = ''
      renderControls()
      options.onReady?.(sceneInfo)
    },
    onFrame: (frame) => {
      status.textContent = `Rendered ${frame.width}×${frame.height} in ${frame.renderMs} ms`
      options.onFrame?.(frame)
    },
    onState: (state) => {
      editedValues = {}
      renderControls()
      options.onState?.(state)
    },
    onLog: (message) => {
      appendLog(message)
      options.onLog?.(message)
    },
    onSceneEvent: (name, payload) => {
      appendLog(`event: ${name} ${JSON.stringify(payload)}`)
      options.onSceneEvent?.(name, payload)
    },
    onError: (message) => {
      status.textContent = message
      status.classList.add('frameos-manager__status--error')
      appendLog(`error: ${message}`)
      options.onError?.(message)
    },
  })

  function currentScene(): FrameOSScene | undefined {
    return (preview.currentSceneId && sceneById.get(preview.currentSceneId)) || options.scenes[0]
  }

  function publicFields(scene: FrameOSScene | undefined): StateField[] {
    return (scene?.fields ?? []).filter((field) => field.access === 'public' && field.name)
  }

  function fieldValues(scene: FrameOSScene | undefined): Record<string, unknown> {
    return stateFieldShowIfValues(publicFields(scene), preview.state, editedValues)
  }

  function renderControls(): void {
    if (destroyed) {
      return
    }
    controls.innerHTML = ''
    const scene = currentScene()

    // Scene switcher, when more than one scene is loaded.
    const scenes = preview.sceneInfo?.scenes ?? []
    if (scenes.length > 1) {
      const row = el('div', 'frameos-manager__row')
      row.appendChild(el('label', 'frameos-manager__label', 'Scene'))
      const select = document.createElement('select')
      select.className = 'frameos-manager__input'
      for (const item of scenes) {
        const option = document.createElement('option')
        option.value = item.id
        option.textContent = item.name || item.id
        option.selected = item.id === preview.currentSceneId
        select.appendChild(option)
      }
      select.onchange = () => {
        editedValues = {}
        preview.selectScene(select.value)
        renderControls()
      }
      row.appendChild(select)
      controls.appendChild(row)
    }

    // State fields, filtered by showIf against current + edited values.
    const fields = publicFields(scene)
    const values = fieldValues(scene)
    const visible = fields.filter((field) => evaluateShowIf(field.showIf, values, field.name))
    for (const field of visible) {
      controls.appendChild(fieldRow(field, values[field.name]))
    }
    if (visible.length > 0) {
      const apply = document.createElement('button')
      apply.type = 'button'
      apply.className = 'frameos-manager__button frameos-manager__button--primary'
      apply.textContent = 'Apply & render'
      apply.onclick = () => {
        const state: Record<string, unknown> = {}
        for (const field of visible) {
          const value = field.name in editedValues ? editedValues[field.name] : values[field.name]
          if (value !== undefined) {
            state[field.name] = coerceStateFieldValue(field, value)
          }
        }
        preview.setSceneState(state)
      }
      controls.appendChild(apply)
    }

    // Custom event nodes as buttons.
    const buttonRow = el('div', 'frameos-manager__row frameos-manager__row--buttons')
    for (const event of sceneEventButtons(scene)) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'frameos-manager__button'
      button.textContent = event.label || event.keyword
      button.onclick = () => preview.sendEvent(event.keyword, {})
      buttonRow.appendChild(button)
    }
    const render = document.createElement('button')
    render.type = 'button'
    render.className = 'frameos-manager__button'
    render.textContent = 'Render'
    render.onclick = () => preview.render()
    buttonRow.appendChild(render)
    controls.appendChild(buttonRow)
  }

  function fieldRow(field: StateField, value: unknown): HTMLElement {
    const row = el('div', 'frameos-manager__row')
    row.appendChild(el('label', 'frameos-manager__label', field.label || field.name))

    const update = (next: unknown): void => {
      editedValues = { ...editedValues, [field.name]: next }
      // showIf conditions may depend on this field: re-render the form (a
      // fresh element keeps focus handling simple — apply happens on click).
      renderControls()
    }

    if (field.type === 'select' || field.type === 'boolean' || field.type === 'font') {
      const select = document.createElement('select')
      select.className = 'frameos-manager__input'
      const opts = field.type === 'boolean' ? ['true', 'false'] : field.options ?? []
      for (const opt of opts) {
        const option = document.createElement('option')
        option.value = opt
        option.textContent = opt
        option.selected = String(value ?? '') === opt
        select.appendChild(option)
      }
      select.onchange = () => update(select.value)
      row.appendChild(select)
    } else if (field.type === 'text') {
      const textarea = document.createElement('textarea')
      textarea.className = 'frameos-manager__input'
      textarea.rows = 3
      textarea.value = value === undefined || value === null ? '' : String(value)
      textarea.onchange = () => update(textarea.value)
      row.appendChild(textarea)
    } else {
      const input = document.createElement('input')
      input.className = 'frameos-manager__input'
      input.type =
        field.type === 'integer' || field.type === 'float'
          ? 'number'
          : field.type === 'date'
          ? 'date'
          : field.type === 'color'
          ? 'color'
          : 'text'
      if (field.type === 'float') {
        input.step = 'any'
      }
      if (field.placeholder) {
        input.placeholder = field.placeholder
      }
      input.value = value === undefined || value === null ? '' : String(value)
      input.onchange = () => update(input.value)
      row.appendChild(input)
    }
    return row
  }

  return {
    preview,
    destroy: () => {
      destroyed = true
      preview.destroy()
      container.innerHTML = ''
      container.classList.remove('frameos-manager')
    },
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text) {
    node.textContent = text
  }
  return node
}

let stylesInjected = false
function injectStyles(): void {
  if (stylesInjected || typeof document === 'undefined') {
    return
  }
  stylesInjected = true
  const style = document.createElement('style')
  style.setAttribute('data-frameos-manager', '')
  style.textContent = `
.frameos-manager { display: flex; flex-direction: column; gap: 12px; font: 14px/1.4 system-ui, sans-serif; }
.frameos-manager__stage { display: flex; justify-content: center; background: #0f172a; border-radius: 12px; padding: 12px; }
.frameos-manager__canvas { max-width: 100%; height: auto; border-radius: 6px; background: #fff; }
.frameos-manager__status { min-height: 1.2em; font-size: 12px; opacity: 0.7; }
.frameos-manager__status--error { color: #dc2626; opacity: 1; }
.frameos-manager__controls { display: flex; flex-direction: column; gap: 8px; }
.frameos-manager__row { display: flex; align-items: center; gap: 8px; }
.frameos-manager__row--buttons { flex-wrap: wrap; }
.frameos-manager__label { min-width: 120px; font-weight: 600; }
.frameos-manager__input { flex: 1; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 8px; background: inherit; color: inherit; }
.frameos-manager__button { padding: 6px 12px; border: 1px solid #cbd5e1; border-radius: 8px; background: transparent; color: inherit; cursor: pointer; }
.frameos-manager__button:hover { background: rgba(100, 116, 139, 0.1); }
.frameos-manager__button--primary { background: #2563eb; border-color: #2563eb; color: #fff; align-self: flex-start; }
.frameos-manager__button--primary:hover { background: #1d4ed8; }
.frameos-manager__logs { max-height: 200px; overflow: auto; margin: 0; padding: 8px 10px; background: rgba(15, 23, 42, 0.05); border-radius: 8px; font-size: 11px; }
`
  document.head.appendChild(style)
}

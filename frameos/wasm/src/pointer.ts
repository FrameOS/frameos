// Input for the preview: the browser's pointer, wheel and keyboard over the
// canvas, sent to the runtime the way a frame's evdev driver sends a mouse, a
// finger or a key (frameos/src/drivers/evdev) — `pointerMove` / `pointerDown`
// / `pointerUp` / `pointerCancel` with both axes 0..32767 across the picture,
// `wheel` in notches, `keyDown` / `keyUp` with the W3C `code` and `key` the
// browser already has, `textInput` for what a key typed. The runtime turns the
// position into the scene's own pixels and makes the gestures (tap, swipe…),
// like the dispatcher does on a frame, so a scene's event nodes see the same
// events in the browser and on hardware. A bundle from before input v2 gets
// the old `mouseMove` / `mouseDown` / `mouseUp` instead.
//
// frontend/src/utils/previewPointer.ts is the same arithmetic for the
// self-hosted frontend, which drives the worker without this package; the
// cloud's shared-spa test `preview-pointer.test.ts` holds the two together.

import { POINTER_WIRE_MAX } from './events.gen'

/** Both axes of a pointer position run 0..POINTER_AXIS_MAX, whatever the size
 * of the picture: the contract's `pointer.wireMax` (docs/events-contract.json),
 * which the evdev driver and the dispatcher read from the same place. */
export const POINTER_AXIS_MAX = POINTER_WIRE_MAX

export interface PointerRect {
  left: number
  top: number
  width: number
  height: number
}

/** Where the picture sits inside an element that letterboxes it
 * (`object-fit: contain`); the element's own box when the aspects agree or a
 * size is unknown. */
export function pointerPictureRect(rect: PointerRect, pictureWidth: number, pictureHeight: number): PointerRect {
  if (!(rect.width > 0 && rect.height > 0 && pictureWidth > 0 && pictureHeight > 0)) {
    return rect
  }
  const scale = Math.min(rect.width / pictureWidth, rect.height / pictureHeight)
  const width = pictureWidth * scale
  const height = pictureHeight * scale
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
  }
}

/** `offset` px into a `size` px long side, as 0..32767. A pointer dragged
 * off the picture (a captured drag) stays on its edge. */
export function pointerAxis(offset: number, size: number): number {
  if (!(size > 0) || !Number.isFinite(offset)) {
    return 0
  }
  return Math.round(Math.min(1, Math.max(0, offset / size)) * POINTER_AXIS_MAX)
}

/** A viewport position (`clientX`/`clientY`) as a wire position. */
export function pointerMovePayload(clientX: number, clientY: number, picture: PointerRect): { x: number; y: number } {
  return {
    x: pointerAxis(clientX - picture.left, picture.width),
    y: pointerAxis(clientY - picture.top, picture.height),
  }
}

/** A DOM `MouseEvent.button` as the evdev driver's button number: 0 left (and
 * a touch), 1 right, 2 middle, 3 side/back, 4 extra/forward; -1 for a button
 * the driver has no name for. The DOM counts middle before right. */
export function pointerButton(domButton: number): number {
  switch (domButton) {
    case 0:
      return 0
    case 1:
      return 2
    case 2:
      return 1
    case 3:
      return 3
    case 4:
      return 4
    default:
      return -1
  }
}

// MouseEvent.buttons' bit for each MouseEvent.button.
const DOM_BUTTONS_BIT: readonly number[] = [1, 4, 2, 8, 16]

/** A DOM `MouseEvent.buttons` mask as the contract's `buttons` mask
 * (`1 << button`, in the driver's numbering). */
export function pointerButtonsMask(domButtons: number): number {
  let mask = 0
  for (let domButton = 0; domButton < DOM_BUTTONS_BIT.length; domButton++) {
    if (domButtons & (DOM_BUTTONS_BIT[domButton] ?? 0)) {
      mask |= 1 << pointerButton(domButton)
    }
  }
  return mask
}

/** The contract's `pointerId`: 0 is the one mouse cursor (the driver's
 * relative pointer); a finger or a pen keeps the browser's own id. */
export function pointerIdOf(event: { pointerId?: number; pointerType?: string }): number {
  if (!event.pointerType || event.pointerType === 'mouse') {
    return 0
  }
  return Math.max(1, Math.abs(Math.trunc(event.pointerId ?? 1)))
}

/** The contract's `pointerType`. */
export function pointerTypeOf(event: { pointerType?: string }): 'mouse' | 'touch' | 'pen' {
  return event.pointerType === 'touch' || event.pointerType === 'pen' ? event.pointerType : 'mouse'
}

/** Wheel deltas in notches: pixels (deltaMode 0) are ~100 a notch, lines
 * (deltaMode 1) 3 a notch, a page (deltaMode 2) is one. Fractions carry over
 * between events, so a trackpad's slow scroll still adds up to a notch. */
export function wheelNotches(delta: number, deltaMode: number, carry: number): { notches: number; carry: number } {
  const perNotch = deltaMode === 1 ? 3 : deltaMode === 2 ? 1 : 100
  const total = carry + delta / perNotch
  const notches = total > 0 ? Math.floor(total) : Math.ceil(total)
  return { notches, carry: total - notches }
}

/** Where input events go: `FrameOSPreview.sendEvent`, or anything shaped like it. */
export type PointerEventSink = (name: string, payload: Record<string, unknown>) => void

export interface AttachPointerOptions {
  /** Whether events are forwarded right now — read on every event, so it can
   * follow the runtime's `pointerEvents` capability without re-attaching. */
  enabled?: () => boolean
  /** Whether the runtime takes input v2 (`inputEvents`: pointer events with a
   * position, id and type; wheel; keyboard). False sends the old
   * `mouseMove` / `mouseDown` / `mouseUp` a 2026.9.21 bundle understands. */
  inputV2?: () => boolean
  /** The keyboard only: the browser's clipboard text for the frame, handed
   * over just before a Ctrl/Cmd+V reaches it, so the frame pastes what the
   * computer copied (docs/jsx-ui.md "Selecting, copying and pasting"). */
  onPaste?: (text: string) => void
}

/**
 * Forward the pointer and the wheel over `canvas` to `send`. Moves are sent
 * at most once per animation frame; a press captures the pointer, so a drag
 * that leaves the canvas still ends with its `pointerUp`. Returns the detach
 * function.
 */
export function attachPointerInput(
  canvas: HTMLCanvasElement,
  send: PointerEventSink,
  options: AttachPointerOptions = {}
): () => void {
  const enabled = (): boolean => (options.enabled ? options.enabled() : true)
  const v2 = (): boolean => (options.inputV2 ? options.inputV2() : false)
  // One queued move per pointer: two fingers each keep their newest.
  const queuedMoves = new Map<number, Record<string, unknown>>()
  let moveFrame: number | null = null
  // What is held, per pointer, and where each pointer was last seen: a
  // cancel may come without coordinates, and it happens where the pointer was.
  const pressed = new Map<number, Set<number>>()
  const pointerTypes = new Map<number, 'mouse' | 'touch' | 'pen'>()
  const lastPositions = new Map<number, { x: number; y: number }>()
  let wheelCarryX = 0
  let wheelCarryY = 0

  const positionOf = (event: PointerEvent | WheelEvent): { x: number; y: number } => {
    const id = pointerIdOf(event as PointerEvent)
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
      return lastPositions.get(id) ?? { x: 0, y: 0 }
    }
    const position = pointerMovePayload(
      event.clientX,
      event.clientY,
      pointerPictureRect(canvas.getBoundingClientRect(), canvas.width, canvas.height)
    )
    lastPositions.set(id, position)
    return position
  }

  const pointerPayload = (event: PointerEvent): Record<string, unknown> => ({
    ...positionOf(event),
    pointerId: pointerIdOf(event),
    pointerType: pointerTypeOf(event),
    buttons: pointerButtonsMask(event.buttons),
  })

  const queueMove = (event: PointerEvent): void => {
    if (v2()) {
      queuedMoves.set(pointerIdOf(event), pointerPayload(event))
    } else {
      queuedMoves.set(0, positionOf(event))
    }
  }

  const flushMoves = (): void => {
    if (moveFrame !== null) {
      cancelAnimationFrame(moveFrame)
      moveFrame = null
    }
    for (const payload of queuedMoves.values()) {
      send(v2() ? 'pointerMove' : 'mouseMove', payload)
    }
    queuedMoves.clear()
  }

  const onMove = (event: PointerEvent): void => {
    if (!enabled()) {
      return
    }
    if (event.button >= 0) {
      // A second button going down or up while another is held arrives as a
      // pointermove that names the button; `buttons` says which way it went.
      if (event.buttons & (DOM_BUTTONS_BIT[event.button] ?? 0)) {
        onDown(event)
      } else {
        release(event)
      }
      return
    }
    const held = pressed.get(pointerIdOf(event))
    if (held && Number.isFinite(event.buttons)) {
      // A move that holds less than was pressed: the release happened where
      // this page never heard it (off the canvas, its capture gone). It
      // happens here, before the move, or the scene goes on dragging.
      const mask = pointerButtonsMask(event.buttons)
      for (const button of [...held]) {
        if (!(mask & (1 << button))) {
          releaseButton(event, button)
        }
      }
    }
    queueMove(event)
    if (moveFrame === null) {
      moveFrame = requestAnimationFrame(() => {
        moveFrame = null
        flushMoves()
      })
    }
  }

  const onDown = (event: PointerEvent): void => {
    const button = pointerButton(event.button)
    if (!enabled() || button < 0) {
      return
    }
    // The position first, then the press: what evdev's SYN_REPORT ordering
    // guarantees a scene on a frame. (In v2 the press carries it too.)
    queueMove(event)
    flushMoves()
    const id = pointerIdOf(event)
    if (!pressed.has(id)) {
      pressed.set(id, new Set())
    }
    pressed.get(id)!.add(button)
    pointerTypes.set(id, pointerTypeOf(event))
    try {
      canvas.setPointerCapture(event.pointerId)
    } catch {
      // A synthetic or already-released pointer cannot be captured.
    }
    // The keyboard follows the pointer: a click on the picture focuses it.
    if (typeof canvas.focus === 'function' && canvas.tabIndex >= 0) {
      canvas.focus({ preventScroll: true })
    }
    send(v2() ? 'pointerDown' : 'mouseDown', v2() ? { ...pointerPayload(event), button } : { button })
  }

  const release = (event: PointerEvent): void => releaseButton(event, pointerButton(event.button))

  const releaseButton = (event: PointerEvent, button: number): void => {
    const id = pointerIdOf(event)
    const held = pressed.get(id)
    if (!held || !held.has(button)) {
      return
    }
    held.delete(button)
    if (held.size === 0) {
      pressed.delete(id)
      pointerTypes.delete(id)
    }
    queueMove(event)
    flushMoves()
    send(v2() ? 'pointerUp' : 'mouseUp', v2() ? { ...pointerPayload(event), button } : { button })
  }

  // A pointer let go of without its release: a cancelled touch (the browser
  // took it for a scroll) never reports which button went up, a capture lost
  // mid-drag (the canvas replaced or hidden) ends with no pointerup, and a
  // detach while a button is held would leave the scene holding a drag
  // nothing ends. Let go of everything that pointer holds.
  const cancelPointer = (id: number, position: { x: number; y: number }): void => {
    const held = pressed.get(id)
    if (!held) {
      return
    }
    pressed.delete(id)
    const pointerType = pointerTypes.get(id) ?? 'mouse'
    pointerTypes.delete(id)
    if (v2()) {
      send('pointerCancel', { ...position, pointerId: id, pointerType })
    } else {
      for (const button of held) {
        send('mouseUp', { button })
      }
    }
  }

  const onCancel = (event: PointerEvent): void => {
    flushMoves()
    cancelPointer(pointerIdOf(event), positionOf(event))
  }

  const onWheel = (event: WheelEvent): void => {
    if (!enabled() || !v2()) {
      return
    }
    event.preventDefault()
    const dx = wheelNotches(event.deltaX, event.deltaMode, wheelCarryX)
    const dy = wheelNotches(event.deltaY, event.deltaMode, wheelCarryY)
    wheelCarryX = dx.carry
    wheelCarryY = dy.carry
    if (dx.notches === 0 && dy.notches === 0) {
      return
    }
    flushMoves()
    send('wheel', { deltaX: dx.notches, deltaY: dy.notches, ...positionOf(event) })
  }

  // A second finger on the picture makes the touch the scene's: two
  // pointers, as a touch panel reports them (a pinch, a two-finger drag).
  // The canvas's `touch-action` leaves one finger's vertical swipe to the
  // page, and a browser that takes a gesture cancels every pointer in it, so
  // a pinch never reached the scene. Holding back the touches' default while
  // more than one is down keeps the page from zooming or scrolling under
  // them (Safari, which reads no `pinch-zoom` in `touch-action`, too).
  const onTouch = (event: TouchEvent): void => {
    if (enabled() && v2() && event.cancelable && (event.touches?.length ?? 0) > 1) {
      event.preventDefault()
    }
  }

  // The right button is a button here, not the browser's menu.
  const onContextMenu = (event: Event): void => {
    if (enabled()) {
      event.preventDefault()
    }
  }

  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointerup', release)
  canvas.addEventListener('pointercancel', onCancel)
  canvas.addEventListener('lostpointercapture', onCancel)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('touchstart', onTouch, { passive: false })
  canvas.addEventListener('touchmove', onTouch, { passive: false })
  canvas.addEventListener('contextmenu', onContextMenu)

  return () => {
    canvas.removeEventListener('pointermove', onMove)
    canvas.removeEventListener('pointerdown', onDown)
    canvas.removeEventListener('pointerup', release)
    canvas.removeEventListener('pointercancel', onCancel)
    canvas.removeEventListener('lostpointercapture', onCancel)
    canvas.removeEventListener('wheel', onWheel)
    canvas.removeEventListener('touchstart', onTouch)
    canvas.removeEventListener('touchmove', onTouch)
    canvas.removeEventListener('contextmenu', onContextMenu)
    if (moveFrame !== null) {
      cancelAnimationFrame(moveFrame)
      moveFrame = null
    }
    queuedMoves.clear()
    for (const id of [...pressed.keys()]) {
      cancelPointer(id, lastPositions.get(id) ?? { x: 0, y: 0 })
    }
    pressed.clear()
    pointerTypes.clear()
    lastPositions.clear()
  }
}

// Keys whose default is to scroll the page: taken by the scene while the
// picture has the focus.
const SCROLLING_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'PageUp',
  'PageDown',
  'Home',
  'End',
])

/** A DOM keyboard event as the contract's `keyDown` / `keyUp` payload. */
export function keyPayload(event: KeyboardEvent, down: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    code: event.code || 'Unidentified',
    key: event.key || 'Unidentified',
    shift: event.shiftKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    meta: event.metaKey,
  }
  if (down) {
    payload.repeat = Boolean(event.repeat)
  }
  return payload
}

/** The text a key press types, or null: one printable character with no
 * Ctrl / Meta chord (Alt alone is AltGr on many layouts, and types). What the
 * frame's dispatcher does with a key from its own driver. */
export function keyText(event: KeyboardEvent): string | null {
  if (event.isComposing || event.ctrlKey || event.metaKey || !event.key) {
    return null
  }
  return [...event.key].length === 1 ? event.key : null
}

/** Ctrl+V, or Cmd+V on a Mac: a paste. */
export function isPasteChord(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && (event.code === 'KeyV' || event.key === 'v' || event.key === 'V')
}

/** The frame's Copy or Cut, on the browser's clipboard as well: what the
 * worker hands on (`{type: 'clipboard', text}`). Quietly nothing where the
 * page may not write it. */
export function writeHostClipboard(text: string): void {
  try {
    void navigator.clipboard?.writeText(text)?.catch(() => undefined)
  } catch {
    // no clipboard here
  }
}

/** How long a Ctrl/Cmd+V waits for the browser's `paste` event, which comes
 * right after the key when there is text to paste. */
const PASTE_WAIT_MS = 100

/**
 * Forward the keyboard, while `canvas` has the focus, to `send` as `keyDown`
 * / `keyUp` / `textInput`. Give the canvas a `tabIndex` so it can take the
 * focus (a press on it focuses it). With `onPaste`, a Ctrl/Cmd+V's `keyDown`
 * waits for the browser's `paste` event and goes after the text it carries.
 * Returns the detach function.
 */
export function attachKeyboardInput(
  canvas: HTMLCanvasElement,
  send: PointerEventSink,
  options: AttachPointerOptions = {}
): () => void {
  const enabled = (): boolean =>
    (options.enabled ? options.enabled() : true) && (options.inputV2 ? options.inputV2() : true)

  // A Ctrl/Cmd+V held back for its `paste` event (the text first, then the
  // key, which pastes it on the frame); without one soon, the key alone.
  let heldPaste: Record<string, unknown> | null = null
  let heldTimer: ReturnType<typeof setTimeout> | null = null
  const releasePaste = (): void => {
    if (heldTimer !== null) {
      clearTimeout(heldTimer)
      heldTimer = null
    }
    if (heldPaste) {
      const payload = heldPaste
      heldPaste = null
      send('keyDown', payload)
    }
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!enabled()) {
      return
    }
    if (SCROLLING_KEYS.has(event.code)) {
      event.preventDefault()
    }
    if (options.onPaste && isPasteChord(event)) {
      releasePaste()
      heldPaste = keyPayload(event, true)
      heldTimer = setTimeout(releasePaste, PASTE_WAIT_MS)
      return
    }
    send('keyDown', keyPayload(event, true))
    const text = keyText(event)
    if (text !== null) {
      send('textInput', { text })
    }
  }

  const onKeyUp = (event: KeyboardEvent): void => {
    if (!enabled()) {
      return
    }
    releasePaste() // a key's up never comes before its down
    send('keyUp', keyPayload(event, false))
  }

  const onPasteEvent = (event: ClipboardEvent): void => {
    if (!enabled() || !options.onPaste) {
      return
    }
    event.preventDefault()
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text) {
      options.onPaste(text)
    }
    releasePaste()
  }

  canvas.addEventListener('keydown', onKeyDown)
  canvas.addEventListener('keyup', onKeyUp)
  canvas.addEventListener('paste', onPasteEvent)
  return () => {
    if (heldTimer !== null) {
      clearTimeout(heldTimer)
    }
    heldPaste = null
    canvas.removeEventListener('keydown', onKeyDown)
    canvas.removeEventListener('keyup', onKeyUp)
    canvas.removeEventListener('paste', onPasteEvent)
  }
}

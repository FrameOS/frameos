// Pointer input for the preview: the browser's pointer over the canvas, sent
// to the runtime the way a frame's evdev driver sends a mouse or a finger
// (frameos/src/drivers/evdev/evdev.nim) — `mouseMove` {x, y} with both axes
// 0..32767 across the picture, then `mouseDown` / `mouseUp` {button}. The
// runtime turns the position into the scene's own pixels, like the runner
// does on a frame, so a scene's `mouseMove`/`mouseUp` event nodes see the
// same numbers in the browser and on hardware.
//
// frontend/src/utils/previewPointer.ts is the same arithmetic for the
// self-hosted frontend, which drives the worker without this package; the
// cloud's shared-spa test `preview-pointer.test.ts` holds the two together.

/** Both axes of a `mouseMove` run 0..POINTER_AXIS_MAX, whatever the size of
 * the picture (evdev's `PointerRange`, image.nim's `PointerAxisMax`). */
export const POINTER_AXIS_MAX = 32767

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

/** A viewport position (`clientX`/`clientY`) as a `mouseMove` payload. */
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

/** Where pointer events go: `FrameOSPreview.sendEvent`, or anything shaped like it. */
export type PointerEventSink = (name: 'mouseMove' | 'mouseDown' | 'mouseUp', payload: Record<string, number>) => void

export interface AttachPointerOptions {
  /** Whether events are forwarded right now — read on every event, so it can
   * follow the runtime's `pointerEvents` capability without re-attaching. */
  enabled?: () => boolean
}

/**
 * Forward the pointer over `canvas` to `send`. Moves are sent at most once
 * per animation frame; a press captures the pointer, so a drag that leaves
 * the canvas still ends with its `mouseUp`. Returns the detach function.
 */
export function attachPointerInput(
  canvas: HTMLCanvasElement,
  send: PointerEventSink,
  options: AttachPointerOptions = {}
): () => void {
  const enabled = (): boolean => (options.enabled ? options.enabled() : true)
  let queuedMove: { x: number; y: number } | null = null
  let moveFrame: number | null = null
  const pressed = new Set<number>()

  const payloadFor = (event: PointerEvent): { x: number; y: number } =>
    pointerMovePayload(
      event.clientX,
      event.clientY,
      pointerPictureRect(canvas.getBoundingClientRect(), canvas.width, canvas.height)
    )

  const flushMove = (): void => {
    if (moveFrame !== null) {
      cancelAnimationFrame(moveFrame)
      moveFrame = null
    }
    if (queuedMove) {
      const payload = queuedMove
      queuedMove = null
      send('mouseMove', payload)
    }
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
    queuedMove = payloadFor(event)
    if (moveFrame === null) {
      moveFrame = requestAnimationFrame(() => {
        moveFrame = null
        flushMove()
      })
    }
  }

  const onDown = (event: PointerEvent): void => {
    const button = pointerButton(event.button)
    if (!enabled() || button < 0) {
      return
    }
    // The position first, then the press: what evdev's SYN_REPORT ordering
    // guarantees a scene on a frame.
    queuedMove = payloadFor(event)
    flushMove()
    pressed.add(button)
    try {
      canvas.setPointerCapture(event.pointerId)
    } catch {
      // A synthetic or already-released pointer cannot be captured.
    }
    send('mouseDown', { button })
  }

  const release = (event: PointerEvent): void => {
    const button = pointerButton(event.button)
    if (!pressed.has(button)) {
      return
    }
    pressed.delete(button)
    queuedMove = payloadFor(event)
    flushMove()
    send('mouseUp', { button })
  }

  // A cancelled touch (the browser took it for a scroll) never reports which
  // button went up: let go of everything that is down.
  const onCancel = (): void => {
    flushMove()
    for (const button of pressed) {
      send('mouseUp', { button })
    }
    pressed.clear()
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
  canvas.addEventListener('contextmenu', onContextMenu)

  return () => {
    canvas.removeEventListener('pointermove', onMove)
    canvas.removeEventListener('pointerdown', onDown)
    canvas.removeEventListener('pointerup', release)
    canvas.removeEventListener('pointercancel', onCancel)
    canvas.removeEventListener('contextmenu', onContextMenu)
    if (moveFrame !== null) {
      cancelAnimationFrame(moveFrame)
      moveFrame = null
    }
    queuedMove = null
    pressed.clear()
  }
}

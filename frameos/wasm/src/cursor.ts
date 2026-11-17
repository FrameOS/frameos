// The mouse cursor over the preview's picture (docs/jsx-ui.md "The mouse
// cursor"). The runtime says what the cursor looks like where the page's
// pointer is — what the scene's UI asks for with its `cursor-*` classes, a
// window's edge its resize arrows — and the page shows it one of two ways:
//
// - the page's own cursor, by CSS name (the default): the browser draws it;
// - the frame's cursor (`drawn`): the page's is hidden over the canvas
//   (`cursor: none`) and the frame's own picture of it is drawn into the
//   canvas's pixels, as a Linux frame with a mouse draws it on its panel
//   (frameos/cursor_panel.nim): the pixels under it kept and put back before
//   the next frame is painted, so it is never in a frame the page keeps.
//
// Exactly one cursor shows: the page's, or the frame's. A touch shows
// neither, as on a frame; the frame's hides `hideMs` after the mouse last
// moved, as the frame's does.

/** The frame's picture of one cursor shape, as the runtime hands it over
 * (`frameos_wasm_cursor_sprite`). */
export interface CursorSprite {
  width: number
  height: number
  /** The pixel that points. */
  hotX: number
  hotY: number
  /** A row after the other: '.' clear, 'X' black, 'o' white. */
  pixels: string
  /** Canvas pixels a sprite pixel takes, as the frame at this size draws it. */
  scale: number
  /** How long after the mouse last moved the frame hides it. */
  hideMs: number
}

export interface CursorRect {
  x: number
  y: number
  w: number
  h: number
}

const CSS_CURSORS = new Set([
  'default',
  'pointer',
  'text',
  'move',
  'ew-resize',
  'ns-resize',
  'nwse-resize',
  'nesw-resize',
  'none',
])

/** The CSS cursor for a shape the runtime named (its names are CSS's);
 * `default` for anything else. */
export function cssCursor(shape: string | null | undefined): string {
  return shape && CSS_CURSORS.has(shape) ? shape : 'default'
}

/** The canvas rectangle the sprite covers with its hot spot at (x, y),
 * clipped to a `width` x `height` canvas; null when none of it is on it. */
export function cursorRect(
  sprite: CursorSprite,
  x: number,
  y: number,
  width: number,
  height: number
): CursorRect | null {
  const k = Math.max(1, Math.round(sprite.scale))
  const left = Math.round(x) - sprite.hotX * k
  const top = Math.round(y) - sprite.hotY * k
  const x0 = Math.max(0, left)
  const y0 = Math.max(0, top)
  const x1 = Math.min(width, left + sprite.width * k)
  const y1 = Math.min(height, top + sprite.height * k)
  if (x1 <= x0 || y1 <= y0) {
    return null
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** The sprite with its hot spot at (x, y) composed over `under` (RGBA, the
 * pixels of `rect`), into a new array: black and white where it draws, the
 * picture elsewhere. */
export function composeCursor(
  under: ArrayLike<number>,
  rect: CursorRect,
  sprite: CursorSprite,
  x: number,
  y: number
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(rect.w * rect.h * 4)
  out.set(under)
  const k = Math.max(1, Math.round(sprite.scale))
  const left = Math.round(x) - sprite.hotX * k
  const top = Math.round(y) - sprite.hotY * k
  for (let row = 0; row < rect.h; row++) {
    const sy = Math.floor((rect.y + row - top) / k)
    if (sy < 0 || sy >= sprite.height) {
      continue
    }
    for (let col = 0; col < rect.w; col++) {
      const sx = Math.floor((rect.x + col - left) / k)
      if (sx < 0 || sx >= sprite.width) {
        continue
      }
      const c = sprite.pixels[sy * sprite.width + sx]
      if (c !== 'X' && c !== 'o') {
        continue
      }
      const value = c === 'X' ? 0 : 255
      const i = (row * rect.w + col) * 4
      out[i] = value
      out[i + 1] = value
      out[i + 2] = value
      out[i + 3] = 255
    }
  }
  return out
}

/**
 * The cursor over one canvas the preview paints: follows the pointer over it,
 * shows the runtime's shape by CSS name, or draws the frame's picture of it
 * into the canvas while `drawn` is on. The preview calls `away()` before it
 * paints a frame and `back()` after.
 */
export class PreviewCursor {
  private shape = 'default'
  private sprite: CursorSprite | null = null
  private drawn: boolean
  private at: { x: number; y: number } | null = null
  private shown = false
  private saved: { rect: CursorRect; pixels: ImageData; width: number; height: number } | null = null
  private hideTimer: ReturnType<typeof setTimeout> | null = null
  private readonly detachListeners: () => void

  constructor(
    private readonly canvas: HTMLCanvasElement,
    drawn = false
  ) {
    this.drawn = drawn
    const onMove = (event: PointerEvent): void => this.pointer(event)
    const onLeave = (): void => this.hide()
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerdown', onMove)
    canvas.addEventListener('pointerleave', onLeave)
    this.detachListeners = () => {
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerdown', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
    }
    this.style()
  }

  /** Whether the frame's cursor is drawn (else the page's own shows). */
  get drawsFramesCursor(): boolean {
    return this.drawn
  }

  setDrawn(drawn: boolean): void {
    if (drawn === this.drawn) {
      return
    }
    this.drawn = drawn
    this.redraw()
    this.style()
  }

  /** What the runtime says the cursor looks like now. */
  setShape(shape: string, sprite: CursorSprite | null): void {
    this.shape = shape
    this.sprite = sprite
    this.redraw()
    this.style()
  }

  /** Before a frame is painted: the canvas holds the last frame again. */
  away(): void {
    const saved = this.saved
    this.saved = null
    if (!saved || saved.width !== this.canvas.width || saved.height !== this.canvas.height) {
      return // resized: the canvas was cleared, nothing of the cursor is left
    }
    this.canvas.getContext('2d')?.putImageData(saved.pixels, saved.rect.x, saved.rect.y)
  }

  /** After a frame is painted: the cursor over it, if it shows. */
  back(): void {
    const sprite = this.sprite
    const at = this.at
    if (!this.drawn || !this.shown || !sprite || !at || this.saved) {
      return
    }
    const rect = cursorRect(sprite, at.x, at.y, this.canvas.width, this.canvas.height)
    const context = this.canvas.getContext('2d')
    if (!rect || !context) {
      return
    }
    const under = context.getImageData(rect.x, rect.y, rect.w, rect.h)
    this.saved = { rect, pixels: under, width: this.canvas.width, height: this.canvas.height }
    context.putImageData(new ImageData(composeCursor(under.data, rect, sprite, at.x, at.y), rect.w, rect.h), rect.x, rect.y)
  }

  detach(): void {
    this.away()
    this.detachListeners()
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    this.canvas.style.cursor = ''
  }

  private pointer(event: PointerEvent): void {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') {
      this.hide() // a finger puts the cursor away, as on a frame
      return
    }
    const box = this.canvas.getBoundingClientRect()
    if (!(box.width > 0 && box.height > 0)) {
      return
    }
    // The canvas's own pixels (the frame's), wherever it is shown at.
    const scale = Math.min(box.width / this.canvas.width, box.height / this.canvas.height)
    const left = box.left + (box.width - this.canvas.width * scale) / 2
    const top = box.top + (box.height - this.canvas.height * scale) / 2
    this.at = { x: (event.clientX - left) / scale, y: (event.clientY - top) / scale }
    this.shown = true
    this.redraw()
    this.style()
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer)
    }
    const hideMs = this.sprite?.hideMs ?? 0
    this.hideTimer = hideMs > 0 ? setTimeout(() => this.hide(), hideMs) : null
  }

  private hide(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    if (!this.shown) {
      return
    }
    this.shown = false
    this.away()
  }

  private redraw(): void {
    this.away()
    this.back()
  }

  private style(): void {
    // The frame's cursor is drawn, so the page's is hidden; without a
    // picture of it (an older runtime) the page's shows after all.
    this.canvas.style.cursor = this.drawn && this.sprite ? 'none' : cssCursor(this.shape)
  }
}

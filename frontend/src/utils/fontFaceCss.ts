import type { FontMetadata } from '../types'

/**
 * A CSS string literal. Font names come from the font file's own metadata
 * (a frame's uploaded fonts, a scene's font assets), so they can hold quotes,
 * backslashes, newlines or `}`. `JSON.stringify` is a JavaScript escape, not a
 * CSS one; this escapes every character CSS strings treat specially as a hex
 * escape, so the value can only ever be one string.
 */
export function cssString(value: string): string {
  let out = '"'
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char === '"' || char === '\\' || code < 0x20 || code === 0x7f) {
      out += `\\${code.toString(16)} `
    } else {
      out += char
    }
  }
  return out + '"'
}

/** A CSS font-weight number: a finite integer from 1 to 1000, else 400. */
export function cssFontWeight(weight: unknown): number {
  const parsed = typeof weight === 'number' ? weight : typeof weight === 'string' ? Number(weight) : NaN
  if (!Number.isFinite(parsed)) {
    return 400
  }
  return Math.min(1000, Math.max(1, Math.round(parsed)))
}

/** The `@font-face` rule that makes a frame font available to the editor. */
export function fontFaceCss(font: Pick<FontMetadata, 'name' | 'weight' | 'italic'>, dataUrl: string): string {
  const family = cssString(String(font.name ?? ''))
  return (
    `@font-face { font-family: ${family}; src: local(${family}), url(${cssString(dataUrl)}) format('truetype'); ` +
    `font-weight: ${cssFontWeight(font.weight)}; font-style: ${font.italic === true ? 'italic' : 'normal'}; }`
  )
}

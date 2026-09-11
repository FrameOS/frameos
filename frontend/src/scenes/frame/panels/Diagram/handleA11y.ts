import type React from 'react'

// Node handles are the diagram's connection points: 10 px dots with no text.
// Most of them also open the new-node picker on click. These props give each
// one a name (screen readers, and a hover tooltip), and make the clickable
// ones focusable and operable from the keyboard.

/** Enter/Space on a focused handle clicks it at its own centre, so the picker
 * opens next to the handle as it does for a mouse click. */
function clickHandleFromKeyboard(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return
  }
  // Keep reactflow's node-level Enter/Space (select) from firing as well.
  event.preventDefault()
  event.stopPropagation()
  const target = event.currentTarget
  const rect = target.getBoundingClientRect()
  target.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    })
  )
}

/** Props for a handle that opens the new-node picker on click. */
export function pickerHandleProps(label: string): {
  role: 'button'
  tabIndex: number
  title: string
  'aria-label': string
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
} {
  return { role: 'button', tabIndex: 0, title: label, 'aria-label': label, onKeyDown: clickHandleFromKeyboard }
}

/** Props for a drag-only handle. */
export function dragHandleProps(label: string): { role: 'img'; title: string; 'aria-label': string } {
  return { role: 'img', title: label, 'aria-label': label }
}

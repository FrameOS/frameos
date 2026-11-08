import { useActions, useValues } from 'kea'
import clsx from 'clsx'

import type { FrameId, FrameScene } from '../../../../types'
import { sceneLayoutLogic } from './sceneLayoutLogic'

/**
 * Which layout an installed scene wears (docs/scene-layouts.md), as a small
 * select under the scene's picture. Nothing on a layout, or on a frame that
 * has none: the tile stays as it was.
 */
export function SceneLayoutPicker({
  frameId,
  sceneId,
  className,
  ariaLabel = 'Layout',
}: {
  frameId: FrameId
  sceneId: string
  className?: string
  ariaLabel?: string
}): JSX.Element | null {
  const logic = sceneLayoutLogic({ frameId, sceneId })
  const { pickerVisible, layouts, current } = useValues(logic)
  const { chooseLayout } = useActions(logic)
  if (!pickerVisible) {
    return null
  }
  return (
    <select
      aria-label={ariaLabel}
      title="The layout this scene is drawn inside. Save the frame to push it."
      value={current?.sceneId ?? ''}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => chooseLayout(event.target.value)}
      className={clsx(
        'frameos-form-control h-5 w-full min-w-0 truncate rounded border px-1 text-[11px] font-medium outline-none focus:ring-1 focus:ring-blue-400',
        className
      )}
    >
      <option value="">No layout</option>
      {(layouts as FrameScene[]).map((layout) => (
        <option key={layout.id} value={layout.id}>
          {layout.name || 'Untitled layout'}
        </option>
      ))}
    </select>
  )
}

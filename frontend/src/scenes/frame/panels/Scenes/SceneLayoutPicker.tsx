import { useActions, useValues } from 'kea'
import clsx from 'clsx'

import type { FrameId, FrameScene } from '../../../../types'
import type { LayoutGroup } from '../../../../utils/sceneLayouts'
import { sceneLayoutLogic } from './sceneLayoutLogic'

/** A layout select's choices: under "Desktops" and "Full screen" when the frame has both kinds. */
export function LayoutOptions({ groups }: { groups: LayoutGroup<FrameScene>[] }): JSX.Element {
  const options = (layouts: FrameScene[]): JSX.Element[] =>
    layouts.map((layout) => (
      <option key={layout.id} value={layout.id}>
        {layout.name || 'Untitled layout'}
      </option>
    ))
  return (
    <>
      {groups.length > 1
        ? groups.map((group) => (
            <optgroup key={group.kind} label={group.title}>
              {options(group.items)}
            </optgroup>
          ))
        : options(groups[0]?.items ?? [])}
    </>
  )
}

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
  const { pickerVisible, layoutGroups, current } = useValues(logic)
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
      <LayoutOptions groups={layoutGroups} />
    </select>
  )
}

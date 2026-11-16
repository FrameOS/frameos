import { SCENE_ICON_VIEWBOX } from '../utils/sceneIcon'

export interface SceneIconProps {
  /** A path that passed sceneIconPath (utils/sceneIcon.ts): one path in the 24 box. */
  path: string
  className?: string
}

/** A scene's icon (docs/scene-icons.md), filled with the text color around it, as a frame draws it. */
export function SceneIcon({ path, className }: SceneIconProps): JSX.Element {
  return (
    <svg viewBox={SCENE_ICON_VIEWBOX} className={className} fill="currentColor" aria-hidden="true" focusable="false">
      <path d={path} />
    </svg>
  )
}

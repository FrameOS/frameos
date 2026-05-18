import clsx from 'clsx'
import { CSSProperties } from 'react'
import { useStore } from 'reactflow'

const OVERVIEW_FADE_START_ZOOM = 1 / 2
const OVERVIEW_FADE_END_ZOOM = 1 / 3
const POINTER_OPACITY_THRESHOLD = 0.5

const zoomSelector = (state: { transform: [number, number, number] }): number => state.transform[2]

interface NodeZoomLabelProps {
  label: string
  backgroundClassName: string
}

export function NodeZoomLabel({ label, backgroundClassName }: NodeZoomLabelProps): JSX.Element | null {
  const zoom = useStore(zoomSelector)
  const normalizedLabel = label.trim()
  const labelLength = Math.max(normalizedLabel.length, 1)
  const opacity = Math.min(
    1,
    Math.max(0, (OVERVIEW_FADE_START_ZOOM - zoom) / (OVERVIEW_FADE_START_ZOOM - OVERVIEW_FADE_END_ZOOM))
  )
  const capturesPointer = opacity >= POINTER_OPACITY_THRESHOLD
  const style = {
    opacity,
    pointerEvents: capturesPointer ? 'auto' : 'none',
    '--frameos-node-label-length': labelLength,
  } as CSSProperties

  return (
    <div className="frameos-node-title frameos-node-zoom-label absolute inset-0 z-20" style={style} aria-hidden="true">
      <div className={clsx('frameos-node-zoom-label__surface', backgroundClassName)}>
        <div className="frameos-node-zoom-label__text">{normalizedLabel}</div>
      </div>
    </div>
  )
}

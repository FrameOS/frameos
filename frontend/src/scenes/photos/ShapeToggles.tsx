import clsx from 'clsx'
import { aspectMarkRect } from './photoEntries'
import { PHOTO_ALBUM_SHAPES, type PhotoAlbumShape } from './photoAlbumScene'

/** A small rectangle with a photo's aspect ratio, for the orientation menus and toggles. */
export function AspectMark({ width, height }: { width: number; height: number }): JSX.Element {
  const box = 14
  const rect = aspectMarkRect(width, height, box)
  return (
    <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} className="shrink-0 opacity-70" aria-hidden="true">
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  )
}

const SHAPE_MARKS: Record<PhotoAlbumShape, { width: number; height: number; label: string }> = {
  landscape: { width: 4, height: 3, label: 'Landscape' },
  portrait: { width: 3, height: 4, label: 'Portrait' },
  square: { width: 1, height: 1, label: 'Square' },
}

/** Which photo shapes an album scene plays: landscape, portrait, square (docs/photos.md, `shapes`). */
export function ShapeToggles({
  value,
  onToggle,
  className,
}: {
  value: readonly PhotoAlbumShape[]
  onToggle: (shape: PhotoAlbumShape) => void
  className?: string
}): JSX.Element {
  return (
    <div className={clsx('space-y-1.5', className)}>
      <div className="frameos-form-label text-sm font-medium">Photos to play</div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Photos to play">
        {PHOTO_ALBUM_SHAPES.map((shape) => {
          const checked = value.includes(shape.value)
          const mark = SHAPE_MARKS[shape.value]
          return (
            <button
              key={shape.value}
              type="button"
              role="checkbox"
              aria-checked={checked}
              onClick={() => onToggle(shape.value)}
              className={clsx(
                'flex h-9 items-center gap-2 rounded-xl px-3 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                checked ? 'frameos-primary-action text-white' : 'frameos-secondary-button'
              )}
            >
              <AspectMark width={mark.width} height={mark.height} />
              {mark.label}
            </button>
          )
        })}
      </div>
      {value.length === 0 ? (
        <p className="text-xs text-red-700">Turn on at least one shape, or the frame has nothing to show.</p>
      ) : null}
    </div>
  )
}

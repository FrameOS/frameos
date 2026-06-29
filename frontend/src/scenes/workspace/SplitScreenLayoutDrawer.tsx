import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { useRef, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from 'react'
import { ArrowLeftIcon, EllipsisHorizontalIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { ColorInput } from '../../components/ColorInput'
import { FrameImage } from '../../components/FrameImage'
import { entityImagesModel } from '../../models/entityImagesModel'
import type { FrameScene, FrameType, StateField } from '../../types'
import { buildSplitScene, frameLogic } from '../frame/frameLogic'
import { StateFieldEdit } from '../frame/panels/Scenes/StateFieldEdit'
import { apiFetch } from '../../utils/apiFetch'
import { buildSplitScreenThumbnail } from '../../utils/splitScreenThumbnail'
import {
  assignSceneToSplitLayoutLeaf,
  splitLayoutLeafBorderEdges,
  splitLayoutDividers,
  splitLayoutLeafRects,
  splitLayoutLeaves,
  splitLayoutOuterBorderEdges,
  splitScreenLayoutPresets,
  type SplitLayoutDivider,
  type SplitLayoutLeaf,
  type SplitLayoutLeafBorderEdges,
  type SplitLayoutLeafRect,
  type SplitLayoutNode,
  type SplitScreenBackground,
  type SplitScreenSceneLayout,
} from '../../utils/splitScreenLayouts'
import { getFrameosSceneDragData, hasFrameosSceneDragData, setFrameosSceneDragData } from './sceneDrag'
import { SceneDependencyConnector } from './SceneDependencyConnector'
import { SceneDependencyFormatMenu } from './SceneDependencyFormatMenu'
import {
  buildSceneDependencyEntries,
  buildSceneDependencyGraph,
  flatSceneDependencyEntries,
  sortScenesAlphabetically,
} from './sceneDependencyGrouping'
import { splitScreenLayoutLogic } from './splitScreenLayoutLogic'
import {
  sceneChildExpansionKey,
  sceneChildExpansionPath,
  sceneDependencyGroupingIsEnabled,
  workspaceLogic,
} from './workspaceLogic'

const DEFAULT_SPLIT_SCENE_NAME = 'Split screen'
const INITIAL_SPLIT_PRESET_COUNT = 3
const PREVIEW_MAX_HEIGHT_VH = 50

function frameAspectRatio(frame: FrameType): string {
  if (!frame.width || !frame.height) {
    return '16 / 10'
  }
  return frame.rotate === 90 || frame.rotate === 270
    ? `${frame.height} / ${frame.width}`
    : `${frame.width} / ${frame.height}`
}

function frameAspectValue(frame: FrameType): number {
  if (!frame.width || !frame.height) {
    return 16 / 10
  }
  const width = frame.rotate === 90 || frame.rotate === 270 ? frame.height : frame.width
  const height = frame.rotate === 90 || frame.rotate === 270 ? frame.width : frame.height
  return width > 0 && height > 0 ? width / height : 16 / 10
}

function sceneById(frame: FrameType): Map<string, FrameScene> {
  return new Map((frame.scenes ?? []).map((scene) => [scene.id, scene]))
}

function sceneTitlePart(scene: FrameScene): string {
  const title = (scene.name || 'Untitled').trim() || 'Untitled'
  const words = title.split(/\s+/)
  if (title.length <= 18 && words.length <= 2) {
    return title
  }
  return words[0] || title
}

function joinedTitle(parts: string[]): string {
  if (parts.length === 0) {
    return DEFAULT_SPLIT_SCENE_NAME
  }
  if (parts.length === 1) {
    return `${parts[0]} split`
  }
  if (parts.length === 2) {
    return `${parts[0]} & ${parts[1]}`
  }
  if (parts.length === 3) {
    return `${parts[0]}, ${parts[1]} & ${parts[2]}`
  }
  return `${parts[0]}, ${parts[1]} & ${parts.length - 2} more`
}

function suggestedSplitSceneTitle(layout: SplitScreenSceneLayout, scenes: Map<string, FrameScene>): string {
  const parts: string[] = []
  for (const leaf of splitLayoutLeaves(layout.root)) {
    const scene = leaf.sceneId ? scenes.get(leaf.sceneId) : null
    if (!scene) {
      continue
    }
    const part = sceneTitlePart(scene)
    if (!parts.includes(part)) {
      parts.push(part)
    }
  }
  return joinedTitle(parts)
}

function previewMaxWidth(frame: FrameType): string {
  return `min(100%, ${(frameAspectValue(frame) * PREVIEW_MAX_HEIGHT_VH).toFixed(3)}vh)`
}

function LayoutThumbnail({ root }: { root: SplitLayoutNode }): JSX.Element {
  const rects = splitLayoutLeafRects(root)

  return (
    <span className="frameos-split-thumbnail relative block aspect-[4/3] w-full overflow-hidden rounded-md">
      {rects.map((rect, index) => (
        <span
          key={rect.leafId}
          className={clsx(
            'frameos-split-thumbnail-cell absolute border',
            index % 3 === 0
              ? 'frameos-split-thumbnail-cell-a'
              : index % 3 === 1
              ? 'frameos-split-thumbnail-cell-b'
              : 'frameos-split-thumbnail-cell-c'
          )}
          style={{
            height: `${rect.height}%`,
            left: `${rect.x}%`,
            top: `${rect.y}%`,
            width: `${rect.width}%`,
          }}
        />
      ))}
    </span>
  )
}

function MoreLayoutsButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      title="More layout options"
      onClick={onClick}
      className="frameos-split-preset-button frameos-card rounded-lg border p-1.5 text-left shadow-sm transition hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      <span className="frameos-split-thumbnail flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-md">
        <EllipsisHorizontalIcon className="frameos-muted h-7 w-7" />
      </span>
      <span className="frameos-muted mt-1 block truncate text-center text-[11px] font-semibold">More options</span>
    </button>
  )
}

function SceneSourceStrip({
  frame,
  onPickScene,
  onSearchChange,
  search,
}: {
  frame: FrameType
  onPickScene: (sceneId: string) => void
  onSearchChange: (search: string) => void
  search: string
}): JSX.Element {
  const { frameAssetFolderExpansion } = useValues(workspaceLogic)
  const { setFrameAssetFolderExpanded } = useActions(workspaceLogic)
  const scenes = sortScenesAlphabetically(frame.scenes ?? [])
  const searchTerm = search.trim().toLowerCase()
  const filteredScenes = searchTerm
    ? scenes.filter((scene) => `${scene.name || ''} ${scene.id}`.toLowerCase().includes(searchTerm))
    : scenes
  const { childrenBySceneId, sceneById } = buildSceneDependencyGraph(scenes)
  const groupingEnabled = sceneDependencyGroupingIsEnabled(frameAssetFolderExpansion, frame.id, 'split')
  const sceneEntries = groupingEnabled
    ? buildSceneDependencyEntries({
        childrenBySceneId,
        frameId: frame.id,
        matchingSceneIds: searchTerm ? new Set(filteredScenes.map((scene) => scene.id)) : null,
        sceneById,
        sceneChildExpansion: frameAssetFolderExpansion,
        scenes,
      })
    : flatSceneDependencyEntries(filteredScenes)

  return (
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="frameos-muted text-xs font-semibold uppercase tracking-wide">Scenes</div>
        <input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search"
          className="frameos-form-control h-7 min-w-0 flex-1 rounded-md border px-2 text-xs font-medium outline-none transition focus:ring-1 focus:ring-blue-400 sm:max-w-44"
        />
        <SceneDependencyFormatMenu frameId={frame.id} surface="split" className="!h-7 !w-7" />
      </div>
      {scenes.length === 0 ? (
        <div className="frameos-muted frameos-inset rounded-lg border px-3 py-3 text-center text-xs font-semibold">
          No scenes available
        </div>
      ) : sceneEntries.length === 0 ? (
        <div className="frameos-muted frameos-inset rounded-lg border px-3 py-3 text-center text-xs font-semibold">
          No matching scenes
        </div>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {sceneEntries.map(({ scene, key, nested }) => {
            const childSceneCount = groupingEnabled ? childrenBySceneId.get(scene.id)?.length ?? 0 : 0
            const childrenExpanded = !!frameAssetFolderExpansion[sceneChildExpansionKey(frame.id, scene.id)]
            return (
              <div key={key} className="relative w-36 shrink-0 sm:w-32">
                {nested ? <SceneDependencyConnector compact /> : null}
                <div
                  draggable
                  onDragStart={(event) => setFrameosSceneDragData(event.dataTransfer, scene.id)}
                  title={scene.name || 'Untitled'}
                  className={clsx(
                    'frameos-card group relative z-[1] w-full overflow-hidden rounded-lg border text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-within:ring-2 focus-within:ring-blue-400',
                    nested && 'frameos-scene-child-tile'
                  )}
                >
                  <button type="button" onClick={() => onPickScene(scene.id)} className="block h-full w-full text-left">
                    <div className="frameos-card-media relative h-16">
                      <FrameImage
                        frameId={frame.id}
                        sceneId={scene.id}
                        thumb
                        refreshable={false}
                        objectFit="cover"
                        className="h-full w-full rounded-none"
                      />
                    </div>
                    <div className="frameos-scene-source-title frameos-strong px-2 py-1.5 text-xs font-semibold leading-snug">
                      {scene.name || 'Untitled'}
                    </div>
                  </button>
                  {childSceneCount > 0 ? (
                    <button
                      type="button"
                      aria-label={`${childrenExpanded ? 'Hide' : 'Show'} ${childSceneCount} nested ${
                        childSceneCount === 1 ? 'scene' : 'scenes'
                      }`}
                      aria-expanded={childrenExpanded}
                      onClick={(event) => {
                        event.stopPropagation()
                        setFrameAssetFolderExpanded(frame.id, sceneChildExpansionPath(scene.id), !childrenExpanded)
                      }}
                      className="frameos-scene-child-toggle frameos-scene-child-toggle--compact absolute right-1.5 top-1.5 z-20 flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 text-[11px] font-bold shadow-sm backdrop-blur-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                    >
                      {childrenExpanded ? '-' : '+'}
                      {childSceneCount}
                    </button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

async function saveSplitScreenThumbnail(
  frame: FrameType,
  layout: SplitScreenSceneLayout,
  sceneId: string,
  updateEntityImage: (entity: string | null, subentity: string, force?: boolean) => void
): Promise<void> {
  const thumbnail = await buildSplitScreenThumbnail(frame, layout).catch(() => null)
  if (!thumbnail) {
    return
  }

  try {
    const response = await apiFetch(`/api/frames/${frame.id}/scene_images/${sceneId}`, {
      method: 'POST',
      body: thumbnail,
    })
    if (response.ok) {
      updateEntityImage(`frames/${frame.id}`, `scene_images/${sceneId}`)
    }
  } catch (error) {
    console.error('Failed to save generated split scene thumbnail', error)
  }
}

function SplitPreviewCell({
  borderEdges,
  borderWidth,
  frame,
  outerBorderWidth,
  rect,
  scene,
  selected,
  onDropScene,
  onRemoveScene,
  onSelect,
}: {
  borderEdges: SplitLayoutLeafBorderEdges
  borderWidth: number
  frame: FrameType
  outerBorderWidth: number
  rect: SplitLayoutLeafRect
  scene: FrameScene | null
  selected: boolean
  onDropScene: (leafId: string, sceneId: string) => void
  onRemoveScene: (leafId: string) => void
  onSelect: (leafId: string) => void
}): JSX.Element {
  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!hasFrameosSceneDragData(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    const sceneId = getFrameosSceneDragData(event.dataTransfer)
    if (!sceneId) {
      return
    }
    event.preventDefault()
    onSelect(rect.leafId)
    onDropScene(rect.leafId, sceneId)
  }

  const handleRemove = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    onSelect(rect.leafId)
    onRemoveScene(rect.leafId)
  }

  const halfBorderWidth = Math.max(0, borderWidth) / 2
  const outerEdges = outerBorderWidth > 0 ? splitLayoutOuterBorderEdges(rect) : null
  const paddingTop = borderEdges.top ? halfBorderWidth : outerEdges?.top ? outerBorderWidth : 0
  const paddingRight = borderEdges.right ? halfBorderWidth : outerEdges?.right ? outerBorderWidth : 0
  const paddingBottom = borderEdges.bottom ? halfBorderWidth : outerEdges?.bottom ? outerBorderWidth : 0
  const paddingLeft = borderEdges.left ? halfBorderWidth : outerEdges?.left ? outerBorderWidth : 0

  return (
    <div
      aria-selected={selected}
      onClick={() => onSelect(rect.leafId)}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={clsx(
        'frameos-split-cell-shell absolute cursor-pointer transition',
        selected && 'frameos-split-cell-selected'
      )}
      style={{
        height: `${rect.height}%`,
        left: `${rect.x}%`,
        paddingBottom: `${paddingBottom}px`,
        paddingLeft: `${paddingLeft}px`,
        paddingRight: `${paddingRight}px`,
        paddingTop: `${paddingTop}px`,
        top: `${rect.y}%`,
        width: `${rect.width}%`,
      }}
    >
      <div
        className={clsx(
          'frameos-split-cell relative h-full w-full overflow-hidden',
          scene ? 'shadow-inner' : 'frameos-split-cell-empty'
        )}
      >
        {scene ? (
          <>
            <FrameImage
              frameId={frame.id}
              sceneId={scene.id}
              thumb
              refreshable={false}
              objectFit="cover"
              className="h-full w-full rounded-none"
            />
            <div className="frameos-split-cell-label frameos-strong absolute inset-x-0 bottom-0 px-2 py-1 text-xs font-semibold backdrop-blur">
              <span className="block truncate">{scene.name || 'Untitled scene'}</span>
            </div>
            <button
              type="button"
              title="Remove scene"
              aria-label="Remove scene"
              onClick={handleRemove}
              className="frameos-icon-button absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-lg shadow-sm backdrop-blur transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </>
        ) : (
          <div className="frameos-muted flex h-full w-full items-center justify-center px-2 text-center text-xs font-semibold">
            <span className="frameos-split-drop-label">Drop scene</span>
          </div>
        )}
      </div>
    </div>
  )
}

function SplitRenderControls({
  background,
  borderWidth,
  frame,
  outerBorderWidth,
  scenes,
  onSetBackgroundColor,
  onSetBackgroundOpacity,
  onSetBackgroundScene,
  onSetBorderWidth,
  onSetOuterBorderWidth,
}: {
  background: SplitScreenBackground
  borderWidth: number
  frame: FrameType
  outerBorderWidth: number
  scenes: FrameScene[]
  onSetBackgroundColor: (color: string) => void
  onSetBackgroundOpacity: (opacity: number) => void
  onSetBackgroundScene: (sceneId: string | null) => void
  onSetBorderWidth: (borderWidth: number) => void
  onSetOuterBorderWidth: (outerBorderWidth: number) => void
}): JSX.Element {
  const backgroundScene = background.sceneId ? scenes.find((scene) => scene.id === background.sceneId) ?? null : null
  const hasBackgroundScene = Boolean(background.sceneId)

  const handleSceneDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!hasFrameosSceneDragData(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleSceneDrop = (event: DragEvent<HTMLDivElement>): void => {
    const sceneId = getFrameosSceneDragData(event.dataTransfer)
    if (!sceneId || !scenes.some((scene) => scene.id === sceneId)) {
      return
    }
    event.preventDefault()
    onSetBackgroundScene(sceneId)
  }

  const handleRemoveBackgroundScene = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    onSetBackgroundScene(null)
  }

  return (
    <div
      className={clsx(
        'frameos-card grid gap-3 rounded-lg border px-3 py-3 shadow-sm',
        hasBackgroundScene ? 'sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]' : 'sm:grid-cols-3'
      )}
    >
      <div className="min-w-0">
        <span className="frameos-muted mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wide">
          <span>Gap</span>
          <span>{borderWidth}px</span>
        </span>
        <input
          type="range"
          min={0}
          max={48}
          step={1}
          value={borderWidth}
          onChange={(event) => onSetBorderWidth(Number(event.target.value))}
          className="w-full accent-[var(--frameos-primary)]"
        />
        <span className="frameos-muted mb-1 mt-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide">
          <span>Border</span>
          <span>{outerBorderWidth}px</span>
        </span>
        <input
          type="range"
          min={0}
          max={48}
          step={1}
          value={outerBorderWidth}
          onChange={(event) => onSetOuterBorderWidth(Number(event.target.value))}
          className="w-full accent-[var(--frameos-primary)]"
        />
      </div>

      <label className="min-w-0">
        <span className="frameos-muted mb-1 block text-xs font-semibold uppercase tracking-wide">Background color</span>
        <ColorInput
          value={background.color}
          onChange={onSetBackgroundColor}
          className="!h-10 !min-w-[60px]"
          placeholder="#f8fafc"
        />
      </label>

      <div className="min-w-0">
        <div className="mb-1 flex min-w-0 items-center justify-between gap-2">
          <span className="frameos-muted block  text-xs font-semibold uppercase tracking-wide">Background scene</span>
          {hasBackgroundScene ? (
            <button
              type="button"
              title="Remove background scene"
              aria-label="Remove background scene"
              onClick={handleRemoveBackgroundScene}
              className="frameos-secondary-button inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-[11px] font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              <XMarkIcon className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        <div
          onDragOver={handleSceneDragOver}
          onDrop={handleSceneDrop}
          className={clsx(
            'frameos-inset flex h-10 min-w-0 items-center overflow-hidden rounded-lg border transition',
            hasBackgroundScene ? 'shadow-inner' : 'border-dashed'
          )}
        >
          {background.sceneId ? (
            <>
              <FrameImage
                frameId={frame.id}
                sceneId={background.sceneId}
                thumb
                refreshable={false}
                objectFit="cover"
                className="h-full w-10 shrink-0 rounded-none"
              />
              <span className="frameos-strong min-w-0 flex-1 truncate px-2 text-xs font-semibold">
                {backgroundScene?.name || 'Background scene'}
              </span>
            </>
          ) : (
            <div className="frameos-muted flex h-full w-full items-center justify-center px-2 text-center text-xs font-semibold">
              <span className="frameos-split-drop-label">Drop scene</span>
            </div>
          )}
        </div>
        {hasBackgroundScene ? (
          <label className="mt-2 block min-w-0">
            <span className="frameos-muted mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wide">
              <span>Opacity</span>
              <span>{Math.round(background.opacity * 100)}%</span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={background.opacity}
              onChange={(event) => onSetBackgroundOpacity(Number(event.target.value))}
              className="w-full accent-[var(--frameos-primary)]"
            />
          </label>
        ) : null}
      </div>
    </div>
  )
}

function SplitSceneOptionsPanel({
  leaf,
  scene,
  onSetSceneStateValue,
}: {
  leaf: SplitLayoutLeaf | null
  scene: FrameScene | null
  onSetSceneStateValue: (leafId: string, field: StateField, value: any) => void
}): JSX.Element {
  if (!leaf) {
    return (
      <div className="frameos-inset rounded-lg border border-dashed px-3 py-3 text-sm font-semibold">
        <span className="frameos-muted">Click a scene panel to set its options.</span>
      </div>
    )
  }

  if (!leaf.sceneId) {
    return (
      <div className="frameos-inset rounded-lg border border-dashed px-3 py-3 text-sm font-semibold">
        <span className="frameos-muted">Drop a scene into the selected panel before setting options.</span>
      </div>
    )
  }

  if (!scene) {
    return (
      <div className="frameos-inset rounded-lg border border-dashed px-3 py-3 text-sm font-semibold">
        <span className="frameos-muted">The selected scene is not available.</span>
      </div>
    )
  }

  const fields = (scene.fields ?? []).filter((field) => field.access === 'public')
  const state = leaf.state ?? {}

  return (
    <div className="frameos-card rounded-lg border px-3 py-3 shadow-sm">
      <div className="mb-3 flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="frameos-muted text-xs font-semibold uppercase tracking-wide">Scene options</div>
          <div className="frameos-strong truncate text-sm font-semibold">{scene.name || 'Untitled scene'}</div>
        </div>
        {Object.keys(state).length > 0 ? (
          <span className="frameos-muted shrink-0 text-xs font-semibold">{Object.keys(state).length} changed</span>
        ) : null}
      </div>

      {fields.length === 0 ? (
        <div className="frameos-muted text-sm font-semibold">This scene does not expose public options.</div>
      ) : (
        <div className="space-y-3 @container">
          {fields.map((field) => {
            const changed = Object.prototype.hasOwnProperty.call(state, field.name)
            return (
              <div key={field.name} className="space-y-1 @md:flex @md:gap-2">
                <label className="frameos-muted text-sm font-semibold @md:w-1/3">
                  {field.label || field.name}
                  {changed ? <span className="frameos-primary-text ml-1 text-xs">modified</span> : null}
                </label>
                <div className="w-full">
                  <StateFieldEdit
                    field={field}
                    value={state[field.name] ?? field.value ?? ''}
                    onChange={(value) => onSetSceneStateValue(leaf.id, field, value)}
                    currentState={{}}
                    stateChanges={state}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SplitPreviewDivider({
  divider,
  previewRef,
  onStartResize,
}: {
  divider: SplitLayoutDivider
  previewRef: RefObject<HTMLDivElement>
  onStartResize: (divider: SplitLayoutDivider, rect: DOMRect, event: PointerEvent<HTMLButtonElement>) => void
}): JSX.Element {
  const vertical = divider.orientation === 'vertical'

  return (
    <button
      type="button"
      title="Resize"
      aria-label="Resize split"
      onPointerDown={(event) => {
        const rect = previewRef.current?.getBoundingClientRect()
        if (!rect) {
          return
        }
        onStartResize(divider, rect, event)
      }}
      className={clsx(
        'frameos-split-divider absolute z-20 touch-none rounded-full shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        vertical ? 'w-5 -translate-x-1/2 cursor-col-resize sm:w-3' : 'h-5 -translate-y-1/2 cursor-row-resize sm:h-3'
      )}
      style={{
        height: vertical ? `${divider.height}%` : undefined,
        left: `${divider.x}%`,
        top: `${divider.y}%`,
        width: vertical ? undefined : `${divider.width}%`,
      }}
    />
  )
}

export function SplitScreenLayoutDrawer({ frame }: { frame: FrameType }): JSX.Element {
  const logic = splitScreenLayoutLogic({ frameId: frame.id })
  const frameKea = frameLogic({ frameId: frame.id })
  const {
    configuredLeafCount,
    editingSceneId,
    layout,
    morePresetsOpen,
    resizing,
    sceneSearch,
    selectedLeafId,
    selectedPresetId,
  } = useValues(logic)
  const {
    assignSceneToLeaf,
    closeGenerator,
    selectLeaf,
    selectPreset,
    setBackgroundColor,
    setBackgroundOpacity,
    setBackgroundScene,
    setBorderWidth,
    setLeafSceneStateValue,
    setLayoutName,
    setOuterBorderWidth,
    setSceneSearch,
    showMorePresets,
    startResize,
  } = useActions(logic)
  const { updateScene } = useActions(frameKea)
  const { updateEntityImage } = useActions(entityImagesModel)
  const { openSceneControl } = useActions(workspaceLogic)
  const previewRef = useRef<HTMLDivElement>(null)
  const scenes = sceneById(frame)
  const frameScenes = frame.scenes ?? []
  const leaves = splitLayoutLeaves(layout.root)
  const selectedLeaf = selectedLeafId ? leaves.find((leaf) => leaf.id === selectedLeafId) ?? null : null
  const selectedLeafScene = selectedLeaf?.sceneId ? scenes.get(selectedLeaf.sceneId) ?? null : null
  const rects = splitLayoutLeafRects(layout.root)
  const borderEdges = splitLayoutLeafBorderEdges(rects)
  const dividers = splitLayoutDividers(layout.root)
  const suggestedTitle = suggestedSplitSceneTitle(layout, scenes)
  const visiblePresets = morePresetsOpen
    ? splitScreenLayoutPresets
    : splitScreenLayoutPresets.slice(0, INITIAL_SPLIT_PRESET_COUNT)
  const editingSplit = Boolean(editingSceneId)

  const handleBack = (): void => {
    closeGenerator()
    if (editingSceneId) {
      openSceneControl(frame.id, editingSceneId)
    }
  }

  const selectPreviewLeaf = (leafId: string): void => {
    selectLeaf(leafId)
    previewRef.current?.focus({ preventScroll: true })
  }

  const handlePickScene = (sceneId: string): void => {
    if (!scenes.has(sceneId)) {
      return
    }
    const targetLeafId =
      selectedLeafId ?? rects.find((rect) => !rect.sceneId)?.leafId ?? rects.find(Boolean)?.leafId ?? null
    if (!targetLeafId) {
      return
    }
    assignSceneWithTitle(targetLeafId, sceneId)
    selectPreviewLeaf(targetLeafId)
  }

  const assignSceneWithTitle = (leafId: string, sceneId: string | null): void => {
    const currentName = layout.name.trim()
    const shouldUseSuggestedTitle =
      !currentName || currentName === DEFAULT_SPLIT_SCENE_NAME || currentName === suggestedTitle
    const nextLayout = {
      ...layout,
      root: assignSceneToSplitLayoutLeaf(layout.root, leafId, sceneId),
    }
    assignSceneToLeaf(leafId, sceneId)
    if (shouldUseSuggestedTitle) {
      setLayoutName(suggestedSplitSceneTitle(nextLayout, scenes))
    }
  }

  const handleDropScene = (leafId: string, sceneId: string): void => {
    if (!scenes.has(sceneId)) {
      return
    }
    assignSceneWithTitle(leafId, sceneId)
  }

  const handleStartResize = (
    divider: SplitLayoutDivider,
    rect: DOMRect,
    event: PointerEvent<HTMLButtonElement>
  ): void => {
    event.preventDefault()
    const vertical = divider.orientation === 'vertical'
    const parentStartPx =
      (vertical ? rect.left : rect.top) +
      ((vertical ? divider.parentX : divider.parentY) / 100) * (vertical ? rect.width : rect.height)
    const parentSizePx =
      ((vertical ? divider.parentWidth : divider.parentHeight) / 100) * (vertical ? rect.width : rect.height)
    startResize(divider.parentId, divider.index, divider.orientation, parentStartPx, parentSizePx)
  }

  const handleSave = async (): Promise<void> => {
    const saveLayout = {
      ...layout,
      name: layout.name.trim() || suggestedTitle,
    }
    const scene = buildSplitScene(frame, saveLayout, editingSceneId)
    updateScene(scene.id, scene)
    await frameKea.asyncActions.submitFrameForm()
    openSceneControl(frame.id, scene.id)
    await saveSplitScreenThumbnail(frame, saveLayout, scene.id, updateEntityImage)
    closeGenerator()
  }

  const handlePreviewKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Backspace' && event.key !== 'Delete') {
      return
    }
    if (!selectedLeafId) {
      return
    }
    event.preventDefault()
    assignSceneWithTitle(selectedLeafId, null)
  }

  return (
    <div className="split-screen-layout-drawer flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 py-3 sm:px-5">
        <button
          type="button"
          onClick={handleBack}
          title={editingSplit ? 'Back to scene' : 'Back to Add scene'}
          aria-label={editingSplit ? 'Back to scene' : 'Back to Add scene'}
          className="frameos-secondary-button inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg !px-0 !py-0 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <label className="min-w-0 flex-1">
          <span className="sr-only">Split scene title</span>
          <input
            type="text"
            value={layout.name}
            placeholder={suggestedTitle}
            onChange={(event) => setLayoutName(event.target.value)}
            className="frameos-form-control h-10 w-full rounded-lg border px-3 text-sm font-semibold outline-none transition focus:ring-2 focus:ring-blue-400"
          />
        </label>
        <button
          type="button"
          onClick={handleSave}
          disabled={configuredLeafCount === 0}
          className="frameos-primary-action inline-flex h-10 shrink-0 items-center justify-center rounded-lg px-4 text-sm font-semibold text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4 sm:px-5 sm:pb-5">
          <div className="frameos-muted text-xs font-semibold">click multiple times to rotate</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {visiblePresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                title={preset.name}
                onClick={() => selectPreset(preset.id, selectedPresetId === preset.id)}
                className={clsx(
                  'frameos-split-preset-button frameos-card rounded-lg border p-1.5 text-left shadow-sm transition hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                  selectedPresetId === preset.id && 'frameos-split-preset-button-selected ring-2'
                )}
              >
                <LayoutThumbnail root={selectedPresetId === preset.id ? layout.root : preset.root} />
                <span className="frameos-muted mt-1 block truncate text-center text-[11px] font-semibold">
                  {preset.name}
                </span>
              </button>
            ))}
            {!morePresetsOpen && <MoreLayoutsButton onClick={showMorePresets} />}
          </div>

          <SplitRenderControls
            background={layout.background}
            borderWidth={layout.borderWidth}
            frame={frame}
            outerBorderWidth={layout.outerBorderWidth}
            scenes={frameScenes}
            onSetBackgroundColor={setBackgroundColor}
            onSetBackgroundOpacity={setBackgroundOpacity}
            onSetBackgroundScene={setBackgroundScene}
            onSetBorderWidth={setBorderWidth}
            onSetOuterBorderWidth={setOuterBorderWidth}
          />

          <div
            ref={previewRef}
            tabIndex={0}
            onKeyDown={handlePreviewKeyDown}
            className={clsx(
              'frameos-split-preview relative mx-auto w-full overflow-hidden rounded-lg border shadow-inner ring-1 focus:outline-none',
              resizing && 'select-none'
            )}
            style={{
              aspectRatio: frameAspectRatio(frame),
              backgroundColor: layout.background.color,
              maxHeight: `${PREVIEW_MAX_HEIGHT_VH}vh`,
              maxWidth: previewMaxWidth(frame),
            }}
          >
            {layout.background.sceneId ? (
              <div
                className="pointer-events-none absolute inset-0"
                style={{ opacity: layout.background.opacity }}
                aria-hidden
              >
                <FrameImage
                  frameId={frame.id}
                  sceneId={layout.background.sceneId}
                  thumb
                  refreshable={false}
                  objectFit="cover"
                  className="h-full w-full rounded-none"
                />
              </div>
            ) : null}
            {rects.map((rect) => (
              <SplitPreviewCell
                key={rect.leafId}
                borderEdges={borderEdges.get(rect.leafId) ?? { top: false, right: false, bottom: false, left: false }}
                borderWidth={layout.borderWidth}
                frame={frame}
                outerBorderWidth={layout.outerBorderWidth}
                rect={rect}
                scene={rect.sceneId ? scenes.get(rect.sceneId) ?? null : null}
                selected={selectedLeafId === rect.leafId}
                onDropScene={handleDropScene}
                onRemoveScene={(leafId) => assignSceneWithTitle(leafId, null)}
                onSelect={selectPreviewLeaf}
              />
            ))}
            {dividers.map((divider) => (
              <SplitPreviewDivider
                key={`${divider.parentId}:${divider.index}`}
                divider={divider}
                previewRef={previewRef}
                onStartResize={handleStartResize}
              />
            ))}
          </div>

          <SplitSceneOptionsPanel
            leaf={selectedLeaf}
            scene={selectedLeafScene}
            onSetSceneStateValue={setLeafSceneStateValue}
          />
        </div>

        <div className="frameos-divider shrink-0 border-t px-4 py-3 sm:px-5">
          <SceneSourceStrip
            frame={frame}
            search={sceneSearch}
            onPickScene={handlePickScene}
            onSearchChange={setSceneSearch}
          />
        </div>
      </div>
    </div>
  )
}

import { actions, beforeUnmount, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import type { splitScreenLayoutLogicType } from './splitScreenLayoutLogicType'
import {
  assignSceneToSplitLayoutLeaf,
  cloneSplitLayoutNode,
  configuredSplitLayoutLeafCount,
  defaultSplitScreenSceneLayout,
  splitLayoutPresetById,
  splitScreenLayoutPresets,
  updateSplitLayoutAdjacentRatio,
  type SplitLayoutBranch,
  type SplitScreenSceneLayout,
} from '../../utils/splitScreenLayouts'

export interface SplitScreenLayoutLogicProps {
  frameId: number
}

export interface SplitScreenResizeState {
  parentId: string
  index: number
  orientation: 'vertical' | 'horizontal'
  parentStartPx: number
  parentSizePx: number
}

function defaultPresetId(): string {
  return splitScreenLayoutPresets[0].id
}

function layoutForPreset(presetId: string): SplitScreenSceneLayout {
  return {
    name: 'Split screen',
    root: cloneSplitLayoutNode(splitLayoutPresetById(presetId).root),
  }
}

function removeResizeListeners(cache: Record<string, any>): void {
  if (typeof window === 'undefined') {
    return
  }
  if (cache.pointerMoveListener) {
    window.removeEventListener('pointermove', cache.pointerMoveListener)
    cache.pointerMoveListener = null
  }
  if (cache.pointerUpListener) {
    window.removeEventListener('pointerup', cache.pointerUpListener)
    window.removeEventListener('pointercancel', cache.pointerUpListener)
    cache.pointerUpListener = null
  }
}

export const splitScreenLayoutLogic = kea<splitScreenLayoutLogicType>([
  path(['src', 'scenes', 'workspace', 'splitScreenLayoutLogic']),
  props({} as SplitScreenLayoutLogicProps),
  key((props) => props.frameId),
  actions({
    openGenerator: true,
    closeGenerator: true,
    showMorePresets: true,
    selectPreset: (presetId: string) => ({ presetId }),
    selectLeaf: (leafId: string | null) => ({ leafId }),
    setLayoutName: (name: string) => ({ name }),
    assignSceneToLeaf: (leafId: string, sceneId: string | null) => ({ leafId, sceneId }),
    startResize: (
      parentId: string,
      index: number,
      orientation: 'vertical' | 'horizontal',
      parentStartPx: number,
      parentSizePx: number
    ) => ({
      index,
      orientation,
      parentId,
      parentSizePx,
      parentStartPx,
    }),
    updateResize: (clientX: number, clientY: number) => ({ clientX, clientY }),
    resizeLayout: (parentId: string, index: number, positionRatio: number) => ({ index, parentId, positionRatio }),
    finishResize: true,
  }),
  reducers({
    generatorOpen: [
      false,
      {
        openGenerator: () => true,
        closeGenerator: () => false,
      },
    ],
    selectedPresetId: [
      defaultPresetId(),
      {
        openGenerator: () => defaultPresetId(),
        selectPreset: (_, { presetId }) => presetId,
      },
    ],
    morePresetsOpen: [
      false,
      {
        openGenerator: () => false,
        showMorePresets: () => true,
      },
    ],
    selectedLeafId: [
      null as string | null,
      {
        openGenerator: () => null,
        closeGenerator: () => null,
        selectPreset: () => null,
        selectLeaf: (_, { leafId }) => leafId,
      },
    ],
    layout: [
      defaultSplitScreenSceneLayout(),
      {
        openGenerator: () => layoutForPreset(defaultPresetId()),
        selectPreset: (_, { presetId }) => layoutForPreset(presetId),
        setLayoutName: (state, { name }) => ({
          ...state,
          name,
        }),
        assignSceneToLeaf: (state, { leafId, sceneId }) => ({
          ...state,
          root: assignSceneToSplitLayoutLeaf(state.root, leafId, sceneId),
        }),
        resizeLayout: (state, { parentId, index, positionRatio }) => ({
          ...state,
          root: updateSplitLayoutAdjacentRatio(state.root, parentId, index, positionRatio),
        }),
      },
    ],
    resizing: [
      null as SplitScreenResizeState | null,
      {
        startResize: (_, payload) => payload,
        finishResize: () => null,
        closeGenerator: () => null,
      },
    ],
  }),
  selectors({
    root: [(s) => [s.layout], (layout): SplitLayoutBranch => layout.root],
    configuredLeafCount: [(s) => [s.root], (root): number => configuredSplitLayoutLeafCount(root)],
  }),
  listeners(({ actions, cache, values }) => ({
    startResize: () => {
      if (typeof window === 'undefined') {
        return
      }
      removeResizeListeners(cache)
      cache.pointerMoveListener = (event: PointerEvent) => {
        event.preventDefault()
        actions.updateResize(event.clientX, event.clientY)
      }
      cache.pointerUpListener = () => actions.finishResize()
      window.addEventListener('pointermove', cache.pointerMoveListener)
      window.addEventListener('pointerup', cache.pointerUpListener)
      window.addEventListener('pointercancel', cache.pointerUpListener)
    },
    updateResize: ({ clientX, clientY }) => {
      const resizing = values.resizing
      if (!resizing || resizing.parentSizePx <= 0) {
        return
      }
      const coordinate = resizing.orientation === 'vertical' ? clientX : clientY
      const positionRatio = (coordinate - resizing.parentStartPx) / resizing.parentSizePx
      actions.resizeLayout(resizing.parentId, resizing.index, positionRatio)
    },
    finishResize: () => removeResizeListeners(cache),
    closeGenerator: () => removeResizeListeners(cache),
  })),
  beforeUnmount(({ cache }) => removeResizeListeners(cache)),
])

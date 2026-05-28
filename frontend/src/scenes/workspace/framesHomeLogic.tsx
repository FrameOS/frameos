import { actions, afterMount, beforeUnmount, connect, kea, listeners, path, reducers } from 'kea'
import { subscriptions } from 'kea-subscriptions'
import { framesModel } from '../../models/framesModel'
import { newFrameForm } from '../frames/newFrameForm'
import { isMobileWorkspaceViewport, workspaceLogic } from './workspaceLogic'
import type { framesHomeLogicType } from './framesHomeLogicType'

function framesMainElement(): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null
  }
  return document.querySelector<HTMLElement>('[data-workspace-main="frames"]')
}

function mobileWorkspaceHeaderOffset(): number {
  if (typeof window === 'undefined') {
    return 0
  }

  return window.matchMedia?.('(max-width: 639px)').matches ? 72 : 84
}

function removeFrameScrollSpy(cache: Record<string, any>): void {
  if (cache.frameScrollElement && cache.frameScrollListener) {
    cache.frameScrollElement.removeEventListener('scroll', cache.frameScrollListener)
  }
  if (cache.documentScrollElement && cache.frameScrollListener) {
    cache.documentScrollElement.removeEventListener('scroll', cache.frameScrollListener)
  }
  if (cache.frameScrollListener && typeof window !== 'undefined') {
    window.removeEventListener('scroll', cache.frameScrollListener)
    window.removeEventListener('resize', cache.frameScrollListener)
    document.removeEventListener('scroll', cache.frameScrollListener)
  }

  cache.frameScrollElement = null
  cache.documentScrollElement = null
}

function currentFrameInView(): number | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return null
  }

  const main = framesMainElement()
  if (!main) {
    return null
  }

  const mainStyle = window.getComputedStyle(main)
  const mainRect = main.getBoundingClientRect()
  const mainScrolls = main.scrollHeight > main.clientHeight + 1 && mainStyle.overflowY !== 'visible'
  const viewportTop = mainScrolls ? mainRect.top : isMobileWorkspaceViewport() ? mobileWorkspaceHeaderOffset() : 0
  const viewportBottom = mainScrolls ? mainRect.bottom : window.innerHeight
  const viewportHeight = Math.max(1, viewportBottom - viewportTop)
  const readingLine = viewportTop + Math.min(isMobileWorkspaceViewport() ? 96 : 220, viewportHeight * 0.35)

  const sections = Array.from(document.querySelectorAll<HTMLElement>('[data-workspace-frame-section]'))
    .map((section) => {
      const frameId = Number(section.dataset.workspaceFrameSection)
      return Number.isFinite(frameId) ? { frameId, rect: section.getBoundingClientRect() } : null
    })
    .filter((section): section is { frameId: number; rect: DOMRect } => section !== null)
    .filter((section) => section.rect.bottom >= viewportTop && section.rect.top <= viewportBottom)

  if (sections.length === 0) {
    return null
  }

  return (
    sections.find((section) => section.rect.top <= readingLine && section.rect.bottom >= readingLine)?.frameId ??
    sections.toSorted(
      (first, second) => Math.abs(first.rect.top - readingLine) - Math.abs(second.rect.top - readingLine)
    )[0]?.frameId ??
    null
  )
}

export const framesHomeLogic = kea<framesHomeLogicType>([
  path(['src', 'scenes', 'workspace', 'framesHomeLogic']),
  connect(() => ({
    values: [framesModel, ['framesList']],
    actions: [workspaceLogic, ['focusFrame', 'selectFrame', 'setSearch']],
  })),
  actions({
    startFrameOrderSnapshot: true,
    snapshotFrameOrderIfNeeded: true,
    markFrameOrderSnapshotted: true,
    attachFrameScrollSpy: true,
    syncFrameFromScroll: true,
  }),
  reducers({
    frameOrderSnapshotted: [
      false,
      {
        startFrameOrderSnapshot: () => false,
        markFrameOrderSnapshotted: () => true,
      },
    ],
  }),
  listeners(({ actions, cache, values }) => ({
    snapshotFrameOrderIfNeeded: () => {
      if (values.frameOrderSnapshotted || values.framesList.length === 0) {
        return
      }
      workspaceLogic.actions.snapshotFrameOrder()
      actions.markFrameOrderSnapshotted()
    },
    attachFrameScrollSpy: () => {
      if (typeof window === 'undefined') {
        return
      }

      if (cache.frameScrollAttachTimer) {
        window.clearTimeout(cache.frameScrollAttachTimer)
        cache.frameScrollAttachTimer = null
      }
      removeFrameScrollSpy(cache)

      window.requestAnimationFrame(() => {
        const main = framesMainElement()
        if (!main) {
          cache.frameScrollAttachTimer = window.setTimeout(() => actions.attachFrameScrollSpy(), 50)
          return
        }

        const listener = () => actions.syncFrameFromScroll()
        const documentScrollElement = document.scrollingElement
        cache.frameScrollElement = main
        cache.documentScrollElement = documentScrollElement
        cache.frameScrollListener = listener
        main.addEventListener('scroll', listener, { passive: true })
        documentScrollElement?.addEventListener('scroll', listener, { passive: true })
        document.addEventListener('scroll', listener, { passive: true })
        window.addEventListener('scroll', listener, { passive: true })
        window.addEventListener('resize', listener)
        actions.syncFrameFromScroll()
      })
    },
    syncFrameFromScroll: () => {
      if (typeof window === 'undefined') {
        return
      }

      if (cache.frameScrollAnimationFrame) {
        window.cancelAnimationFrame(cache.frameScrollAnimationFrame)
      }
      cache.frameScrollAnimationFrame = window.requestAnimationFrame(() => {
        const frameId = currentFrameInView()
        if (frameId !== null) {
          actions.selectFrame(frameId)
        }
      })
    },
    [workspaceLogic.actionTypes.openSecondarySidebar]: () => {
      actions.syncFrameFromScroll()
    },
    [workspaceLogic.actionTypes.toggleSecondarySidebar]: () => {
      actions.syncFrameFromScroll()
    },
    [newFrameForm.actionTypes.frameCreated]: ({ frameId }) => {
      actions.setSearch('')
      actions.focusFrame(frameId)
    },
  })),
  subscriptions(({ actions, values }) => ({
    framesList: () => {
      if (!values.frameOrderSnapshotted) {
        actions.snapshotFrameOrderIfNeeded()
      }
      actions.syncFrameFromScroll()
    },
  })),
  afterMount(({ actions }) => {
    actions.startFrameOrderSnapshot()
    actions.snapshotFrameOrderIfNeeded()
    actions.attachFrameScrollSpy()
  }),
  beforeUnmount(({ cache }) => {
    if (typeof window === 'undefined') {
      return
    }
    removeFrameScrollSpy(cache)
    if (cache.frameScrollAnimationFrame) {
      window.cancelAnimationFrame(cache.frameScrollAnimationFrame)
    }
    if (cache.frameScrollAttachTimer) {
      window.clearTimeout(cache.frameScrollAttachTimer)
    }
  }),
])

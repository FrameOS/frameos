import { router } from 'kea-router'
import { useActions, useMountedLogic, useValues } from 'kea'
import clsx from 'clsx'
import { useEffect, useState, type CSSProperties, type MouseEvent } from 'react'
import {
  ChevronDownIcon,
  ChevronUpIcon,
  Cog6ToothIcon,
  CodeBracketIcon,
  ComputerDesktopIcon,
  MoonIcon,
  RectangleGroupIcon,
  Squares2X2Icon,
  SunIcon,
} from '@heroicons/react/24/outline'
import { FrameosLogo } from '../../components/FrameosLogo'
import { Spinner } from '../../components/Spinner'
import { urls } from '../../urls'
import { preloadSceneComponent, type LoadableSceneKey } from '../scenes'
import { FrameDashboardLoadingSkeleton, FrameHomeTopBarLoadingSkeleton } from './FrameDashboardLoadingSkeleton'
import { isMobileWorkspaceViewport, workspaceLogic } from './workspaceLogic'
import { workspaceModeForSceneOrFrames, type WorkspaceMode } from './workspaceModes'

function LoadingNavButton({
  active,
  href,
  pending,
  preloadScene,
  sidebarOpen,
  title,
  onActiveClick,
  children,
}: {
  active: boolean
  href: string
  pending: boolean
  preloadScene: LoadableSceneKey
  sidebarOpen: boolean
  title: string
  onActiveClick: () => void
  children: JSX.Element
}): JSX.Element {
  const resolvedHref =
    sidebarOpen && isMobileWorkspaceViewport() ? `${href.split('#')[0]}#workspaceSidebar=open` : href.split('#')[0]
  const preload = () => preloadSceneComponent(preloadScene)

  return (
    <a
      href={resolvedHref}
      title={title}
      onPointerEnter={preload}
      onFocus={preload}
      onMouseDown={preload}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return
        }
        event.preventDefault()
        if (active) {
          onActiveClick()
        } else {
          router.actions.push(resolvedHref)
        }
      }}
      className={clsx(
        'frameos-nav-button flex h-12 w-12 items-center justify-center rounded-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        active
          ? 'frameos-primary-active text-white shadow-lg'
          : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
      )}
    >
      {pending ? (
        <Spinner
          className="workspace-nav-spinner flex h-7 w-7 items-center justify-center"
          color={active ? 'white' : undefined}
        />
      ) : active ? (
        <>
          {sidebarOpen ? (
            <ChevronUpIcon className="h-7 w-7 lg:hidden" />
          ) : (
            <ChevronDownIcon className="h-7 w-7 lg:hidden" />
          )}
          <span className="hidden lg:flex">{children}</span>
        </>
      ) : (
        children
      )}
    </a>
  )
}

function useDelayedInitialSpinnerMode(mode: WorkspaceMode): WorkspaceMode | null {
  const [spinnerMode, setSpinnerMode] = useState<WorkspaceMode | null>(null)

  useEffect(() => {
    setSpinnerMode(null)
    const timeout = window.setTimeout(() => setSpinnerMode(mode), 100)
    return () => window.clearTimeout(timeout)
  }, [mode])

  return spinnerMode
}

function SidebarLoadingPlaceholder(): JSX.Element {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="frameos-skeleton-line h-3 w-16 animate-pulse rounded-full" />
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="frameos-skeleton-surface flex items-center gap-3 rounded-xl px-3 py-2.5">
            <div className="frameos-skeleton-media h-5 w-5 shrink-0 animate-pulse rounded-md" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="frameos-skeleton-line h-3 w-28 max-w-full animate-pulse rounded-full" />
              <div className="frameos-skeleton-line h-2 w-20 max-w-full animate-pulse rounded-full opacity-70" />
            </div>
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <div className="frameos-skeleton-line h-3 w-20 animate-pulse rounded-full" />
        {[0, 1].map((index) => (
          <div key={index} className="frameos-skeleton-surface flex items-center gap-3 rounded-xl px-3 py-2.5">
            <div className="frameos-skeleton-media h-5 w-5 shrink-0 animate-pulse rounded-md" />
            <div className="frameos-skeleton-line h-3 w-32 max-w-full animate-pulse rounded-full" />
          </div>
        ))}
      </div>
    </div>
  )
}

function MainLoadingPlaceholder({ mode }: { mode: WorkspaceMode }): JSX.Element {
  if (mode === 'scenes') {
    return (
      <div className="scene-editor-canvas scene-editor-canvas-full h-screen min-h-screen overflow-hidden">
        <div className="h-full w-full bg-white/35" />
      </div>
    )
  }

  if (mode === 'apps') {
    return (
      <div className="flex h-screen flex-col gap-4 overflow-hidden pb-5 pr-5 pt-5">
        <div className="frameos-skeleton-surface h-16 shrink-0 animate-pulse rounded-xl" />
        <div className="frameos-skeleton-surface min-h-0 flex-1 animate-pulse rounded-xl" />
      </div>
    )
  }

  if (mode === 'frames') {
    return (
      <div className="py-6 pr-8 max-lg:px-4 max-lg:pb-6">
        <FrameHomeTopBarLoadingSkeleton />
        <FrameDashboardLoadingSkeleton />
      </div>
    )
  }

  return (
    <div className="space-y-6 py-6 pr-8">
      <div className="flex items-center justify-between gap-4">
        <div className="frameos-skeleton-line h-12 w-80 max-w-full animate-pulse rounded-2xl" />
        <div className="frameos-skeleton-line h-12 w-12 animate-pulse rounded-xl" />
      </div>
      {[0, 1, 2].map((index) => (
        <div key={index} className="frameos-skeleton-surface h-40 animate-pulse rounded-xl" />
      ))}
    </div>
  )
}

export function WorkspaceRouteLoading({ scene }: { scene: string | null }): JSX.Element {
  useMountedLogic(workspaceLogic)
  const { secondarySidebarOpen, selectedFrame, selectedSceneId, theme } = useValues(workspaceLogic)
  const { toggleSecondarySidebar, toggleTheme } = useActions(workspaceLogic)
  const mode = workspaceModeForSceneOrFrames(scene)
  const spinnerMode = useDelayedInitialSpinnerMode(mode)
  const frameHref = selectedFrame ? urls.frame(selectedFrame.id) : urls.frames()
  const scenesHref = selectedFrame ? urls.scenes(selectedFrame.id, selectedSceneId ?? undefined) : urls.scenes()
  const appsHref = selectedFrame ? urls.apps(selectedFrame.id, selectedSceneId ?? undefined) : urls.apps()
  const workspaceMainStyle = {
    '--workspace-main-offset': secondarySidebarOpen ? '480px' : '128px',
    '--workspace-sidebar-edge': secondarySidebarOpen ? '440px' : '108px',
  } as CSSProperties
  const preloadFrames = () => preloadSceneComponent('frames')

  return (
    <div className={clsx('frameos-app-shell min-h-screen overflow-x-hidden text-slate-900', `frameos-theme-${theme}`)}>
      <aside
        className={clsx(
          'workspace-sidebar frameos-panel fixed bottom-5 left-5 top-5 z-30 flex max-w-[calc(100vw-40px)] overflow-hidden rounded-[24px] border border-white/80 bg-white/90 shadow-2xl shadow-slate-400/30 backdrop-blur-xl transition-[width] duration-200',
          secondarySidebarOpen ? 'w-[420px]' : 'workspace-sidebar-collapsed w-[88px]'
        )}
      >
        <div
          className={clsx(
            'frameos-rail flex w-[88px] shrink-0 flex-col items-center py-5',
            secondarySidebarOpen ? 'border-r border-slate-200/80' : 'max-lg:border-r max-lg:border-slate-200/80'
          )}
        >
          <a
            href={urls.frames()}
            title="Frames home"
            onPointerEnter={preloadFrames}
            onFocus={preloadFrames}
            onMouseDown={preloadFrames}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                return
              }
              event.preventDefault()
              router.actions.push(urls.frames())
            }}
            className="workspace-logo-button frameos-icon-button mb-8 flex h-12 w-12 items-center justify-center rounded-xl transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <FrameosLogo variant={theme === 'dark' ? 'white-colors' : 'color'} className="h-10 w-10" />
          </a>
          <nav className="flex flex-1 flex-col items-center gap-4">
            <LoadingNavButton
              active={mode === 'frames'}
              href={urls.frames()}
              pending={spinnerMode === 'frames'}
              preloadScene="frames"
              sidebarOpen={secondarySidebarOpen}
              title={secondarySidebarOpen && mode === 'frames' ? 'Hide frames panel' : 'Frames'}
              onActiveClick={toggleSecondarySidebar}
            >
              <Squares2X2Icon className="h-7 w-7" />
            </LoadingNavButton>
            <LoadingNavButton
              active={mode === 'frame'}
              href={frameHref}
              pending={spinnerMode === 'frame'}
              preloadScene="frame"
              sidebarOpen={secondarySidebarOpen}
              title={secondarySidebarOpen && mode === 'frame' ? 'Hide frame panel' : 'Frame'}
              onActiveClick={toggleSecondarySidebar}
            >
              <ComputerDesktopIcon className="h-7 w-7" />
            </LoadingNavButton>
            <LoadingNavButton
              active={mode === 'scenes'}
              href={scenesHref}
              pending={spinnerMode === 'scenes'}
              preloadScene="sceneWorkspace"
              sidebarOpen={secondarySidebarOpen}
              title={secondarySidebarOpen && mode === 'scenes' ? 'Hide scenes panel' : 'Scenes'}
              onActiveClick={toggleSecondarySidebar}
            >
              <RectangleGroupIcon className="h-7 w-7" />
            </LoadingNavButton>
            <LoadingNavButton
              active={mode === 'apps'}
              href={appsHref}
              pending={spinnerMode === 'apps'}
              preloadScene="appsWorkspace"
              sidebarOpen={secondarySidebarOpen}
              title={secondarySidebarOpen && mode === 'apps' ? 'Hide apps panel' : 'Apps'}
              onActiveClick={toggleSecondarySidebar}
            >
              <CodeBracketIcon className="h-7 w-7" />
            </LoadingNavButton>
          </nav>
          <button
            type="button"
            title={theme === 'dark' ? 'Use light mode' : 'Use dark mode'}
            onClick={toggleTheme}
            className="workspace-theme-button frameos-icon-button mb-4 flex h-12 w-12 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            {theme === 'dark' ? <SunIcon className="h-7 w-7" /> : <MoonIcon className="h-7 w-7" />}
          </button>
          <LoadingNavButton
            active={mode === 'settings'}
            href={urls.settings()}
            pending={spinnerMode === 'settings'}
            preloadScene="settings"
            sidebarOpen={secondarySidebarOpen}
            title={secondarySidebarOpen && mode === 'settings' ? 'Hide settings panel' : 'Settings'}
            onActiveClick={toggleSecondarySidebar}
          >
            <Cog6ToothIcon className="h-8 w-8" />
          </LoadingNavButton>
        </div>
        <div
          className={clsx(
            'workspace-secondary-panel min-w-0 flex-1 flex-col',
            secondarySidebarOpen ? 'flex' : 'hidden'
          )}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-6">
            <SidebarLoadingPlaceholder />
          </div>
        </div>
      </aside>
      <main
        data-workspace-main={mode}
        style={workspaceMainStyle}
        className={clsx(
          'workspace-main @container',
          mode === 'scenes'
            ? 'scene-workspace-main h-screen overflow-hidden p-0'
            : mode === 'apps'
            ? 'apps-workspace-main h-screen overflow-hidden max-lg:h-auto max-lg:overflow-visible max-lg:px-4'
            : 'h-screen overflow-y-auto max-lg:h-auto max-lg:overflow-visible max-lg:px-4 max-lg:pb-6'
        )}
      >
        <MainLoadingPlaceholder mode={mode} />
      </main>
    </div>
  )
}

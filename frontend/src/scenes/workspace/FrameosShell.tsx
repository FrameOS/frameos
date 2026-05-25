import { A, router } from 'kea-router'
import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import clsx from 'clsx'
import { useEffect, useState, type CSSProperties, type MouseEvent, type SVGProps } from 'react'
import {
  ChevronDownIcon,
  ChevronUpIcon,
  Cog6ToothIcon,
  CodeBracketIcon,
  ComputerDesktopIcon,
  CloudArrowUpIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PlusIcon,
  RectangleGroupIcon,
  SparklesIcon,
  Squares2X2Icon,
  SunIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { urls } from '../../urls'
import { FrameosLogo } from '../../components/FrameosLogo'
import { Spinner } from '../../components/Spinner'
import { preloadSceneComponent, type LoadableSceneKey } from '../scenes'
import { sceneLogic } from '../sceneLogic'
import { isMobileWorkspaceViewport, workspaceLogic } from './workspaceLogic'
import { workspaceModeForScene, type WorkspaceMode } from './workspaceModes'
import { framesModel } from '../../models/framesModel'
import { frameHost } from '../../decorators/frame'
import { frameLogic } from '../frame/frameLogic'
import { panelsLogic } from '../frame/panels/panelsLogic'
import { Chat } from '../frame/panels/Chat/Chat'
import { chatLogic } from '../frame/panels/Chat/chatLogic'
import { workspaceChatDrawerLogic } from './workspaceChatDrawerLogic'

const frameShellToolPanels = new Set([
  'overview',
  'preview',
  'schedule',
  'logs',
  'metrics',
  'assets',
  'terminal',
  'ping',
  'debug',
  'settings',
])

interface FrameosShellProps {
  mode: WorkspaceMode
  title: string
  subtitle?: string
  tree: JSX.Element
  children: JSX.Element
  mainClassName?: string
  sidebarHeader?: JSX.Element | null
  topBar?: JSX.Element | null
  topBarClassName?: string
  rightPanel?: JSX.Element | null
  toolbar?: JSX.Element | null
  primaryActionLabel?: string
  onPrimaryAction?: () => void
  showAiButton?: boolean
}

function NavButton({
  active,
  current,
  href,
  pending,
  preloadScene,
  sidebarOpen,
  title,
  onActiveClick,
  onInactiveClick,
  children,
}: {
  active: boolean
  current: boolean
  href: string
  pending: boolean
  preloadScene: LoadableSceneKey
  sidebarOpen: boolean
  title: string
  onActiveClick: () => void
  onInactiveClick: () => void
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
        if (current) {
          onActiveClick()
        } else {
          onInactiveClick()
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

function useDelayedPendingMode(currentMode: WorkspaceMode): {
  activeMode: WorkspaceMode
  pendingMode: WorkspaceMode | null
} {
  const { scene } = useValues(sceneLogic)
  const routeMode = workspaceModeForScene(scene)
  const nextPendingMode = routeMode && routeMode !== currentMode ? routeMode : null
  const [pendingMode, setPendingMode] = useState<WorkspaceMode | null>(null)

  useEffect(() => {
    if (!nextPendingMode) {
      setPendingMode(null)
      return
    }
    setPendingMode(null)
    const timeout = window.setTimeout(() => setPendingMode(nextPendingMode), 100)
    return () => window.clearTimeout(timeout)
  }, [nextPendingMode])

  return {
    activeMode: routeMode ?? currentMode,
    pendingMode,
  }
}

function AiMagicButton({
  active,
  onClick,
  floating = false,
}: {
  active: boolean
  onClick: () => void
  floating?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      title="Open AI chat"
      onClick={onClick}
      className={clsx(
        'frameos-secondary-button flex h-12 w-12 items-center justify-center rounded-xl bg-white/80 !px-0 !py-0 text-slate-700 shadow-lg shadow-slate-300/25 transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        active && 'ring-2 ring-blue-300',
        floating && 'pointer-events-auto'
      )}
    >
      <SparklesIcon className="h-6 w-6" />
    </button>
  )
}

function WorkspaceChatDrawer({ frameId, sceneId }: { frameId: number; sceneId: string | null }): JSX.Element | null {
  useMountedLogic(chatLogic({ frameId, sceneId }))
  useMountedLogic(workspaceChatDrawerLogic({ frameId, sceneId }))
  const { frames } = useValues(framesModel)
  const { closeChatDrawer } = useActions(workspaceLogic)
  const frame = frames[frameId]
  const frameLogicProps = { frameId }

  if (!frame) {
    return null
  }

  return (
    <div className="workspace-drawer frameos-drawer fixed bottom-5 right-5 top-5 z-40 flex w-[430px] overflow-hidden rounded-[24px] border border-white/80 bg-white/95 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <BindLogic logic={frameLogic} props={frameLogicProps}>
        <BindLogic logic={panelsLogic} props={frameLogicProps}>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="frameos-divider flex items-start justify-between gap-3 border-b px-5 py-4">
              <div className="min-w-0">
                <h2 className="frameos-strong truncate text-xl font-bold tracking-normal">AI chat</h2>
                <div className="frameos-muted truncate text-xs font-semibold uppercase tracking-wide">
                  {frame.name || frameHost(frame)}
                </div>
              </div>
              <button
                type="button"
                onClick={closeChatDrawer}
                className="frameos-icon-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden p-5">
              <Chat />
            </div>
          </div>
        </BindLogic>
      </BindLogic>
    </div>
  )
}

function DeployToFrameIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true" {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5.75 3.75h12.5a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5H5.75a1.5 1.5 0 0 1-1.5-1.5v-6.5a1.5 1.5 0 0 1 1.5-1.5Z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 10.25h10" />
      {/* <path strokeLinecap="round" strokeLinejoin="round" d="M7 7.25h10" /> */}
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 7h5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21.25v-5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m9.25 18.5 2.75-2.75 2.75 2.75" />
    </svg>
  )
}

function FrameStatusHeaderButton({ frameId }: { frameId: number }): JSX.Element | null {
  const { undeployedChanges, unsavedChanges } = useValues(frameLogic({ frameId }))
  const { showDeployPlanModal, showUnsavedChangesModal } = useActions(frameLogic({ frameId }))
  const { closeChatDrawer, closeSecondarySidebar } = useActions(workspaceLogic)
  const statusLabel = unsavedChanges ? 'Unsaved' : undeployedChanges ? 'Undeployed' : null
  const StatusIcon = unsavedChanges ? CloudArrowUpIcon : DeployToFrameIcon

  if (!statusLabel) {
    return null
  }

  return (
    <button
      type="button"
      title={`${statusLabel} changes`}
      aria-label={unsavedChanges ? 'Open unsaved changes' : 'Open deploy plan for undeployed changes'}
      onClick={() => {
        closeChatDrawer()
        if (isMobileWorkspaceViewport()) {
          closeSecondarySidebar()
        }
        if (unsavedChanges) {
          showUnsavedChangesModal()
        } else {
          showDeployPlanModal()
        }
      }}
      className={clsx(
        'workspace-unsaved-header-button flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        'frameos-warning-button'
      )}
    >
      <StatusIcon className="h-5 w-5 shrink-0" />
      <span className="workspace-unsaved-header-label">{statusLabel}</span>
    </button>
  )
}

export function FrameosShell({
  mode,
  tree,
  children,
  mainClassName,
  sidebarHeader,
  topBar,
  topBarClassName,
  rightPanel,
  toolbar,
  primaryActionLabel,
  onPrimaryAction,
  showAiButton: showAiButtonProp,
}: FrameosShellProps): JSX.Element {
  const { chatDrawerSelection, search, secondarySidebarOpen, selectedFrame, selectedSceneId, theme, utilityPanel } =
    useValues(workspaceLogic)
  const { closeScheduleDrawer, closeTemplateDrawer, openChatDrawer, setSearch, toggleSecondarySidebar, toggleTheme } =
    useActions(workspaceLogic)
  const activeFrameTool = frameShellToolPanels.has(String(utilityPanel)) ? String(utilityPanel) : undefined
  const frameHref = selectedFrame ? urls.frame(selectedFrame.id, activeFrameTool) : urls.frames()
  const scenesHref = selectedFrame ? urls.scenes(selectedFrame.id, selectedSceneId ?? undefined) : urls.scenes()
  const appsHref = selectedFrame ? urls.apps(selectedFrame.id, selectedSceneId ?? undefined) : urls.apps()
  const showAiButton = showAiButtonProp ?? (mode !== 'frames' && mode !== 'settings' && !!selectedFrame)
  const chatSceneId = mode === 'scenes' || mode === 'apps' ? selectedSceneId : null
  const chatDrawerIsOpen = !!chatDrawerSelection
  const workspaceRightPanel = chatDrawerSelection ? (
    <WorkspaceChatDrawer frameId={chatDrawerSelection.frameId} sceneId={chatDrawerSelection.sceneId} />
  ) : (
    rightPanel
  )
  const aiButton =
    showAiButton && selectedFrame ? (
      <AiMagicButton
        active={chatDrawerIsOpen}
        onClick={() => openChatDrawer(selectedFrame.id, chatSceneId)}
        floating={topBar === null}
      />
    ) : null
  const unsavedHeaderButton =
    selectedFrame && mode !== 'frames' && mode !== 'settings' ? (
      <FrameStatusHeaderButton frameId={selectedFrame.id} />
    ) : null
  const workspaceMainStyle = {
    '--workspace-main-offset': secondarySidebarOpen ? '480px' : '128px',
    '--workspace-sidebar-edge': secondarySidebarOpen ? '440px' : '108px',
  } as CSSProperties
  const { activeMode, pendingMode } = useDelayedPendingMode(mode)
  const preloadFrames = () => preloadSceneComponent('frames')
  const prepareFirstLevelNavigation = () => {
    closeTemplateDrawer()
    closeScheduleDrawer()
  }

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
          <A
            href={urls.frames()}
            title="Frames home"
            onPointerEnter={preloadFrames}
            onFocus={preloadFrames}
            onMouseDown={preloadFrames}
            className="workspace-logo-button frameos-icon-button mb-8 flex h-12 w-12 items-center justify-center rounded-xl transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <FrameosLogo variant={theme === 'dark' ? 'white-colors' : 'color'} className="h-10 w-10" />
          </A>
          <nav className="flex flex-1 flex-col items-center gap-4">
            <NavButton
              active={activeMode === 'frames'}
              current={mode === 'frames'}
              href={urls.frames()}
              pending={pendingMode === 'frames'}
              preloadScene="frames"
              sidebarOpen={secondarySidebarOpen}
              title={secondarySidebarOpen && mode === 'frames' ? 'Hide frames panel' : 'Frames'}
              onActiveClick={toggleSecondarySidebar}
              onInactiveClick={prepareFirstLevelNavigation}
            >
              <Squares2X2Icon className="h-7 w-7" />
            </NavButton>
            <NavButton
              active={activeMode === 'frame'}
              current={mode === 'frame'}
              href={frameHref}
              pending={pendingMode === 'frame'}
              preloadScene="frame"
              sidebarOpen={secondarySidebarOpen}
              title={secondarySidebarOpen && mode === 'frame' ? 'Hide frame panel' : 'Frame'}
              onActiveClick={toggleSecondarySidebar}
              onInactiveClick={prepareFirstLevelNavigation}
            >
              <ComputerDesktopIcon className="h-7 w-7" />
            </NavButton>
            <NavButton
              active={activeMode === 'scenes'}
              current={mode === 'scenes'}
              href={scenesHref}
              pending={pendingMode === 'scenes'}
              preloadScene="sceneWorkspace"
              sidebarOpen={secondarySidebarOpen}
              title={secondarySidebarOpen && mode === 'scenes' ? 'Hide scenes panel' : 'Scenes'}
              onActiveClick={toggleSecondarySidebar}
              onInactiveClick={prepareFirstLevelNavigation}
            >
              <RectangleGroupIcon className="h-7 w-7" />
            </NavButton>
            <NavButton
              active={activeMode === 'apps'}
              current={mode === 'apps'}
              href={appsHref}
              pending={pendingMode === 'apps'}
              preloadScene="appsWorkspace"
              sidebarOpen={secondarySidebarOpen}
              title={secondarySidebarOpen && mode === 'apps' ? 'Hide apps panel' : 'Apps'}
              onActiveClick={toggleSecondarySidebar}
              onInactiveClick={prepareFirstLevelNavigation}
            >
              <CodeBracketIcon className="h-7 w-7" />
            </NavButton>
          </nav>
          {unsavedHeaderButton}
          <button
            type="button"
            title={theme === 'dark' ? 'Use light mode' : 'Use dark mode'}
            onClick={toggleTheme}
            className="workspace-theme-button frameos-icon-button mb-4 flex h-12 w-12 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            {theme === 'dark' ? <SunIcon className="h-7 w-7" /> : <MoonIcon className="h-7 w-7" />}
          </button>
          <NavButton
            active={activeMode === 'settings'}
            current={mode === 'settings'}
            href={urls.settings()}
            pending={pendingMode === 'settings'}
            preloadScene="settings"
            sidebarOpen={secondarySidebarOpen}
            title={secondarySidebarOpen && mode === 'settings' ? 'Hide settings panel' : 'Settings'}
            onActiveClick={toggleSecondarySidebar}
            onInactiveClick={prepareFirstLevelNavigation}
          >
            <Cog6ToothIcon className="h-8 w-8" />
          </NavButton>
        </div>
        <div
          className={clsx(
            'workspace-secondary-panel min-w-0 flex-1 flex-col',
            secondarySidebarOpen ? 'flex' : 'hidden'
          )}
        >
          {sidebarHeader}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-6">{tree}</div>
        </div>
      </aside>
      <main
        data-workspace-main={mode}
        style={workspaceMainStyle}
        className={clsx(
          'workspace-main @container',
          workspaceRightPanel && 'workspace-main-with-right-panel',
          mainClassName ??
            'h-screen overflow-y-auto py-6 pr-8 max-lg:h-auto max-lg:overflow-visible max-lg:px-4 max-lg:pb-6'
        )}
      >
        {topBar !== undefined ? (
          topBar === null ? (
            aiButton ? (
              <div
                className={clsx(
                  'workspace-floating-ai-button pointer-events-none fixed top-6 z-20',
                  workspaceRightPanel ? 'right-[520px]' : 'right-8'
                )}
              >
                {aiButton}
              </div>
            ) : null
          ) : aiButton ? (
            <div className="relative pr-14">
              {topBar}
              <div className="absolute right-0 top-0">{aiButton}</div>
            </div>
          ) : (
            <div>{topBar}</div>
          )
        ) : (
          <div
            className={clsx(
              'mb-8 flex flex-col items-stretch justify-between gap-4 @md:flex-row @md:items-center',
              topBarClassName
            )}
          >
            <div className="relative w-full max-w-sm">
              <MagnifyingGlassIcon className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search..."
                className="frameos-input h-12 w-full rounded-2xl border border-white/90 bg-white/90 pl-12 pr-4 text-base text-slate-900 shadow-lg shadow-slate-300/35 outline-none transition placeholder:text-slate-400 focus:ring-2 focus:ring-blue-400"
              />
            </div>
            <div className="flex items-center justify-end gap-3">
              {toolbar}
              {aiButton}
              {onPrimaryAction ? (
                <button
                  type="button"
                  onClick={onPrimaryAction}
                  title={primaryActionLabel}
                  className="frameos-primary-action flex h-12 w-12 items-center justify-center rounded-xl text-white shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  <PlusIcon className="h-7 w-7" />
                </button>
              ) : null}
            </div>
          </div>
        )}
        {children}
      </main>
      {workspaceRightPanel}
    </div>
  )
}

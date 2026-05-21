import { A } from 'kea-router'
import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import {
  Cog6ToothIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  RectangleGroupIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline'
import { urls } from '../../urls'
import logo from '../../assets/logo/dark-mark-small.png'
import { workspaceLogic } from './workspaceLogic'

type WorkspaceMode = 'frames' | 'scenes' | 'settings'

interface HomeyShellProps {
  mode: WorkspaceMode
  title: string
  subtitle?: string
  tree: JSX.Element
  children: JSX.Element
  rightPanel?: JSX.Element | null
  toolbar?: JSX.Element | null
  primaryActionLabel?: string
  onPrimaryAction?: () => void
}

function NavButton({
  active,
  href,
  title,
  children,
}: {
  active: boolean
  href: string
  title: string
  children: JSX.Element
}): JSX.Element {
  return (
    <A
      href={href}
      title={title}
      className={clsx(
        'flex h-12 w-12 items-center justify-center rounded-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        active
          ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/25'
          : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
      )}
    >
      {children}
    </A>
  )
}

export function HomeyShell({
  mode,
  title,
  subtitle,
  tree,
  children,
  rightPanel,
  toolbar,
  primaryActionLabel,
  onPrimaryAction,
}: HomeyShellProps): JSX.Element {
  const { search, selectedFrame, selectedSceneId } = useValues(workspaceLogic)
  const { setSearch } = useActions(workspaceLogic)
  const scenesHref = selectedFrame ? urls.scenes(selectedFrame.id, selectedSceneId ?? undefined) : urls.scenes()

  return (
    <div className="frameos-homey-shell min-h-screen overflow-hidden text-slate-900 max-lg:overflow-auto">
      <aside className="fixed bottom-5 left-5 top-5 z-30 flex w-[420px] max-w-[calc(100vw-40px)] overflow-hidden rounded-[24px] border border-white/80 bg-white/90 shadow-2xl shadow-slate-400/30 backdrop-blur-xl max-lg:static max-lg:m-4 max-lg:h-[48vh] max-lg:w-auto">
        <div className="flex w-[88px] shrink-0 flex-col items-center border-r border-slate-200/80 py-5">
          <div className="mb-8 flex h-12 w-12 items-center justify-center">
            <img src={logo} alt="FrameOS" className="h-10 w-10 rounded-full" />
          </div>
          <nav className="flex flex-1 flex-col items-center gap-4">
            <NavButton active={mode === 'frames'} href={urls.frames()} title="Frames">
              <Squares2X2Icon className="h-7 w-7" />
            </NavButton>
            <NavButton active={mode === 'scenes'} href={scenesHref} title="Scenes">
              <RectangleGroupIcon className="h-7 w-7" />
            </NavButton>
          </nav>
          <NavButton active={mode === 'settings'} href={urls.settings()} title="Settings">
            <Cog6ToothIcon className="h-8 w-8" />
          </NavButton>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 px-6 pb-4 pt-6">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-2xl font-bold tracking-normal text-slate-950">{title}</h1>
              {subtitle ? <div className="mt-0.5 truncate text-sm text-slate-500">{subtitle}</div> : null}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">{tree}</div>
        </div>
      </aside>
      <main className="h-screen overflow-y-auto py-6 pl-[480px] pr-8 max-lg:h-auto max-lg:overflow-visible max-lg:px-4 max-lg:pb-6 max-lg:pt-0">
        <div className="mb-8 flex items-center justify-between gap-4 max-md:flex-col max-md:items-stretch">
          <div className="relative w-full max-w-sm">
            <MagnifyingGlassIcon className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search..."
              className="h-12 w-full rounded-2xl border border-white/90 bg-white/90 pl-12 pr-4 text-base text-slate-900 shadow-lg shadow-slate-300/35 outline-none transition placeholder:text-slate-400 focus:ring-2 focus:ring-blue-400"
            />
          </div>
          <div className="flex items-center justify-end gap-3">
            {toolbar}
            {onPrimaryAction ? (
              <button
                type="button"
                onClick={onPrimaryAction}
                title={primaryActionLabel}
                className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-500 text-white shadow-lg shadow-blue-500/30 transition hover:bg-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <PlusIcon className="h-7 w-7" />
              </button>
            ) : null}
          </div>
        </div>
        {children}
      </main>
      {rightPanel}
    </div>
  )
}

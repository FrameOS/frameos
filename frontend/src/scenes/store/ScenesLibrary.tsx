import { useActions, useValues } from 'kea'
import { A } from 'kea-router'
import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  BuildingStorefrontIcon,
  CloudIcon,
  FolderIcon,
  PhotoIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'

import { Spinner } from '../../components/Spinner'
import type { TemplateType } from '../../types'
import { urls } from '../../urls'
import { imageElementIsBlank } from '../../utils/blankImage'
import {
  scenesLibraryPageLabel,
  scenesLibraryPages,
  workspaceMode,
  type ScenesLibraryPage as ScenesLibraryPageKey,
} from '../workspace/workspaceSurfaces'
import { scenesLibraryLogic } from './scenesLibraryLogic'

// The scenes library: the pages at the top of the Scenes side panel and
// what the page area shows for them. A store or drive scene opens on its
// own page (the template's `url`: the scene page of whichever cloud the
// plane is linked to), which is the full-screen editor it has always been;
// a frame's installed scenes keep the editor in this workspace.

const pageIcons: Record<ScenesLibraryPageKey, typeof CloudIcon> = {
  store: BuildingStorefrontIcon,
  cloud: CloudIcon,
  local: FolderIcon,
}

/** The side panel: the library pages, then the frame's installed scenes. */
export function ScenesSidePanel({
  activePage,
  children,
}: {
  activePage: ScenesLibraryPageKey | null
  children: ReactNode
}): JSX.Element {
  const mode = workspaceMode()
  return (
    <div className="space-y-5">
      <nav aria-label="Scene library" className="space-y-1">
        {scenesLibraryPages[mode].map((page) => {
          const Icon = pageIcons[page]
          const active = page === activePage
          return (
            <A
              key={page}
              href={urls.scenesHome(page)}
              aria-current={active ? 'page' : undefined}
              className={clsx(
                'frameos-settings-nav-link flex items-center gap-3 rounded-xl px-3 py-2.5 text-base font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                active ? 'frameos-settings-nav-link-active' : 'text-slate-700 hover:bg-slate-100'
              )}
            >
              <Icon aria-hidden className="h-5 w-5 shrink-0 opacity-80" />
              <span className="min-w-0 truncate">{scenesLibraryPageLabel(page, mode)}</span>
            </A>
          )
        })}
      </nav>
      <section aria-label="Installed scenes">
        <div className="frameos-muted mb-2 px-2 text-xs font-semibold uppercase tracking-wide">Installed scenes</div>
        {children}
      </section>
    </div>
  )
}

function SceneCover({ imageUrl }: { imageUrl: string | null }): JSX.Element {
  const [unusable, setUnusable] = useState(false)
  useEffect(() => setUnusable(false), [imageUrl])
  return (
    <div className="relative flex aspect-[5/3] w-full items-center justify-center overflow-hidden rounded-t-[18px] border-b border-slate-500/15 bg-[#1f2937]">
      <PhotoIcon className="h-10 w-10 text-[#3b4757]" aria-hidden="true" />
      {imageUrl && !unusable ? (
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setUnusable(true)}
          onLoad={(event) => {
            if (imageElementIsBlank(event.currentTarget)) {
              setUnusable(true)
            }
          }}
        />
      ) : null}
    </div>
  )
}

function SceneCard({
  template,
  badge,
  actions,
}: {
  template: TemplateType
  badge?: string
  actions?: ReactNode
}): JSX.Element {
  const href = typeof template.url === 'string' && template.url ? template.url : null
  const body = (
    <>
      <SceneCover imageUrl={typeof template.image === 'string' ? template.image : null} />
      <div className="space-y-1 p-3">
        <div className="flex items-start gap-2">
          <div className="frameos-strong min-w-0 flex-1 truncate text-sm font-semibold">{template.name}</div>
          {badge ? (
            <span className="frameos-inset shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide">
              {badge}
            </span>
          ) : null}
        </div>
        {template.author ? <div className="frameos-muted truncate text-xs">by {template.author}</div> : null}
        {template.description ? (
          <p className="frameos-muted line-clamp-2 text-xs leading-relaxed">{template.description}</p>
        ) : null}
      </div>
    </>
  )
  const className =
    'frameos-card group block overflow-hidden rounded-[18px] border text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'
  return (
    <div className="flex flex-col">
      {href ? (
        <a href={href} className={clsx(className, 'hover:-translate-y-0.5 hover:shadow-lg')}>
          {body}
        </a>
      ) : (
        <div className={className}>{body}</div>
      )}
      {actions ? <div className="mt-2 flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}

function CardGrid({ children }: { children: ReactNode }): JSX.Element {
  return <div className="grid gap-4 @md:grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-4">{children}</div>
}

function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description: string
  actions?: ReactNode
}): JSX.Element {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="frameos-strong text-3xl font-bold tracking-normal">{title}</h1>
        <p className="frameos-muted mt-1 max-w-3xl text-sm leading-relaxed">{description}</p>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

function Note({ children }: { children: ReactNode }): JSX.Element {
  return <div className="frameos-inset rounded-xl border p-4 text-sm leading-relaxed">{children}</div>
}

function RefreshButton({ onClick, loading }: { onClick: () => void; loading: boolean }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="frameos-form-control flex h-10 items-center gap-2 rounded-xl border px-3 text-sm font-semibold transition hover:bg-slate-50 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      {loading ? <Spinner className="h-4 w-4" /> : <ArrowPathIcon className="h-4 w-4" />}
      Refresh
    </button>
  )
}

function StorePage(): JSX.Element {
  const { storeShelves, storeScenesCount, repositoriesLoading, search } = useValues(scenesLibraryLogic)
  const { loadRepositories } = useActions(scenesLibraryLogic)
  const mode = workspaceMode()
  return (
    <>
      <PageHeader
        title="Scene store"
        description="Ready-made scenes from the FrameOS community. Open one to see it in the editor, then install it on a frame."
        actions={<RefreshButton onClick={loadRepositories} loading={repositoriesLoading} />}
      />
      {repositoriesLoading && storeScenesCount === 0 ? (
        <div className="frameos-muted flex items-center gap-2 text-sm">
          <Spinner className="h-4 w-4" />
          Loading the scene store…
        </div>
      ) : storeShelves.length === 0 ? (
        <Note>
          {storeScenesCount === 0
            ? mode === 'frameAdmin'
              ? "The scene store could not be reached. Check the frame's connection and try again."
              : 'The public scene store is not available right now. Check the connection to FrameOS Cloud in Settings.'
            : `No store scenes match "${search}".`}
        </Note>
      ) : (
        <div className="space-y-10">
          {storeShelves.map(({ shelf, templates }) => (
            <section key={shelf.slug} className="space-y-3">
              <h2 className="frameos-heading text-xl font-bold">{shelf.title}</h2>
              <CardGrid>
                {templates.map((template) => (
                  <SceneCard key={template.sceneId ?? template.id ?? template.name} template={template} />
                ))}
              </CardGrid>
            </section>
          ))}
        </div>
      )}
    </>
  )
}

function CloudScenesPage(): JSX.Element {
  const {
    drivePageTemplates,
    driveTemplates,
    driveTemplatesLoading,
    hasDriveScope,
    cloudConnected,
    cloudEnabled,
    search,
  } = useValues(scenesLibraryLogic)
  const { loadDrive } = useActions(scenesLibraryLogic)
  const mode = workspaceMode()
  const title = scenesLibraryPageLabel('cloud', mode)
  const description =
    mode === 'cloud'
      ? 'Your own scenes, private to your account until you publish them to the store.'
      : 'Your copies in FrameOS Cloud, private to your account: install them on any frame, from any backend you link.'
  if (!cloudEnabled) {
    return (
      <>
        <PageHeader title={title} description={description} />
        <Note>FrameOS Cloud is disabled on this backend.</Note>
      </>
    )
  }
  if (!hasDriveScope) {
    return (
      <>
        <PageHeader title={title} description={description} />
        <Note>
          {cloudConnected
            ? 'Turn on the private scenes feature of your cloud link to see them here. '
            : 'Link this backend to FrameOS Cloud to keep private scenes there. '}
          <A href={urls.settings()} className="font-semibold underline-offset-2 hover:underline">
            Open Settings
          </A>
        </Note>
      </>
    )
  }
  return (
    <>
      <PageHeader
        title={title}
        description={description}
        actions={<RefreshButton onClick={loadDrive} loading={driveTemplatesLoading} />}
      />
      {driveTemplatesLoading && driveTemplates.length === 0 ? (
        <div className="frameos-muted flex items-center gap-2 text-sm">
          <Spinner className="h-4 w-4" />
          Loading your scenes…
        </div>
      ) : drivePageTemplates.length === 0 ? (
        <Note>
          {driveTemplates.length === 0
            ? 'No private scenes yet. Save a scene from a frame with "Save to cloud", or fork one from the store.'
            : `No private scenes match "${search}".`}
        </Note>
      ) : (
        <CardGrid>
          {drivePageTemplates.map((template) => (
            <SceneCard
              key={template.sceneId ?? template.id ?? template.name}
              template={template}
              badge={template.visibility === 'public' ? 'public' : 'private'}
            />
          ))}
        </CardGrid>
      )}
    </>
  )
}

function LocalScenesPage(): JSX.Element {
  const { localPageTemplates, templates, templatesLoading, search } = useValues(scenesLibraryLogic)
  const { exportTemplate, removeTemplate } = useActions(scenesLibraryLogic)
  const actionClass =
    'frameos-form-control flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'
  return (
    <>
      <PageHeader
        title={scenesLibraryPageLabel('local')}
        description="Scenes saved on this backend. Install one from a frame's Add scene drawer, or download it as a zip."
      />
      {templatesLoading && templates.length === 0 ? (
        <div className="frameos-muted flex items-center gap-2 text-sm">
          <Spinner className="h-4 w-4" />
          Loading saved scenes…
        </div>
      ) : localPageTemplates.length === 0 ? (
        <Note>
          {templates.length === 0
            ? 'No saved scenes yet. Save a scene from a frame with "Save to My scenes".'
            : `No saved scenes match "${search}".`}
        </Note>
      ) : (
        <CardGrid>
          {localPageTemplates.map((template) => (
            <SceneCard
              key={template.id ?? template.name}
              template={template}
              actions={
                template.id ? (
                  <>
                    <button type="button" className={actionClass} onClick={() => exportTemplate(template.id!, 'zip')}>
                      <ArrowDownTrayIcon className="h-4 w-4" />
                      Download .zip
                    </button>
                    <button
                      type="button"
                      className={clsx(actionClass, 'text-red-600')}
                      onClick={() => {
                        if (window.confirm(`Delete "${template.name}" from this backend?`)) {
                          removeTemplate(template.id!)
                        }
                      }}
                    >
                      <TrashIcon className="h-4 w-4" />
                      Delete
                    </button>
                  </>
                ) : null
              }
            />
          ))}
        </CardGrid>
      )}
    </>
  )
}

/** The page area for a library page. */
export function ScenesLibraryPage({ page }: { page: ScenesLibraryPageKey }): JSX.Element {
  return (
    <div className="mx-auto max-w-6xl pb-16 @container">
      {page === 'store' ? <StorePage /> : page === 'cloud' ? <CloudScenesPage /> : <LocalScenesPage />}
    </div>
  )
}

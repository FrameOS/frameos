import { useActions, useValues } from 'kea'
import { A, router } from 'kea-router'
import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowUpTrayIcon,
  BuildingStorefrontIcon,
  CloudIcon,
  DocumentPlusIcon,
  FolderIcon,
  SparklesIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'

import { Spinner } from '../../components/Spinner'
import { urls } from '../../urls'
import { storeShelfForCategory } from '../../utils/storeCategories'
import {
  Note,
  Pill,
  SceneTile,
  StoreShelves,
  StoreTagCloud,
  TileGrid,
  scrollStoreToTop,
  watchVisibleShelf,
} from './StoreTiles'
import {
  scenesLibraryPageLabel,
  scenesLibraryPages,
  workspaceMode,
  type ScenesLibraryPage as ScenesLibraryPageKey,
} from '../workspace/workspaceSurfaces'
import { scenesLibraryLogic } from './scenesLibraryLogic'

// The scenes library: the pages at the top of the Scenes side panel and
// what the page area shows for them — the store front as the cloud's own
// store page draws it (the three ways to a new scene, shelves of small
// tiles, the tag cloud), the private scenes the same way. A store or drive
// scene opens on its own page (the template's `url`: the scene page of
// whichever cloud the plane is linked to), which is the full-screen editor
// it has always been; a frame's installed scenes keep the editor here.

const pageIcons: Record<ScenesLibraryPageKey, typeof CloudIcon> = {
  store: BuildingStorefrontIcon,
  cloud: CloudIcon,
  local: FolderIcon,
}

const navLinkClass =
  'frameos-settings-nav-link flex items-center gap-3 rounded-xl px-3 py-2.5 text-base font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'

/** The side panel: the library pages (with the store's categories under
 * the store while it is open), then the frame's installed scenes. */
export function ScenesSidePanel({
  activePage,
  children,
}: {
  activePage: ScenesLibraryPageKey | null
  children: ReactNode
}): JSX.Element {
  const mode = workspaceMode()
  const { storeShelfCounts, category, storeScenesCount, visibleShelf } = useValues(scenesLibraryLogic)
  // Under "All scenes" the highlighted category follows the shelf in view.
  const highlightedCategory = category ?? visibleShelf
  return (
    <div className="space-y-5">
      <nav aria-label="Scene library" className="space-y-1">
        {scenesLibraryPages[mode].map((page) => {
          const Icon = pageIcons[page]
          const active = page === activePage
          return (
            <div key={page}>
              <A
                href={urls.scenesHome(page)}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  navLinkClass,
                  active ? 'frameos-settings-nav-link-active' : 'text-slate-700 hover:bg-slate-100'
                )}
              >
                <Icon aria-hidden className="h-5 w-5 shrink-0 opacity-80" />
                <span className="min-w-0 truncate">{scenesLibraryPageLabel(page, mode)}</span>
              </A>
              {page === 'store' && active && storeShelfCounts.length > 0 ? (
                <div className="mt-1 space-y-0.5 pl-6">
                  <CategoryLink label="All scenes" count={storeScenesCount} active={!highlightedCategory} slug={null} />
                  {storeShelfCounts.map(({ shelf, count }) => (
                    <CategoryLink
                      key={shelf.slug}
                      label={shelf.title}
                      count={count}
                      active={highlightedCategory === shelf.slug}
                      slug={shelf.slug}
                    />
                  ))}
                </div>
              ) : null}
            </div>
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

function CategoryLink({
  label,
  count,
  active,
  slug,
}: {
  label: string
  count: number
  active: boolean
  slug: string | null
}): JSX.Element {
  return (
    <A
      href={urls.scenesHome('store', { category: slug })}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'frameos-settings-nav-link flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        active ? 'frameos-settings-nav-link-active font-semibold' : 'text-slate-600 hover:bg-slate-100'
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="frameos-muted text-xs">{count}</span>
    </A>
  )
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

// The three ways to a new scene, as the store page offers them. AI and the
// blank editor are the cloud's new-scene page (the linked cloud's, which
// signs the visitor in itself); the zip lands in the private scenes this
// plane keeps — the cloud drive, or a backend's local saved scenes.
function ActionCard({
  title,
  description,
  icon,
  href,
  onClick,
  pressed,
  tint,
}: {
  title: string
  description: string
  icon: ReactNode
  href?: string
  onClick?: () => void
  pressed?: boolean
  tint: 'gold' | 'slate' | 'teal'
}): JSX.Element {
  const className = clsx(
    'frameos-card relative flex min-h-[7.5rem] flex-col gap-2 overflow-hidden rounded-2xl border p-4 text-left transition hover:-translate-y-0.5 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
    pressed && 'ring-2 ring-blue-400',
    tint === 'gold' && 'bg-gradient-to-br from-amber-400/15 to-transparent',
    tint === 'slate' && 'bg-gradient-to-br from-slate-400/15 to-transparent',
    tint === 'teal' && 'bg-gradient-to-br from-teal-400/15 to-transparent'
  )
  const body = (
    <>
      <span className="pointer-events-none absolute -right-3 -top-3 opacity-[0.07] [&>svg]:h-24 [&>svg]:w-24">
        {icon}
      </span>
      <span className="frameos-inset flex h-8 w-8 items-center justify-center rounded-lg border [&>svg]:h-4 [&>svg]:w-4">
        {icon}
      </span>
      <span className="frameos-strong text-sm font-semibold">{title}</span>
      <span className="frameos-muted text-xs leading-relaxed">{description}</span>
    </>
  )
  return href ? (
    <a href={href} className={className}>
      {body}
    </a>
  ) : (
    <button type="button" className={className} onClick={onClick} aria-pressed={pressed}>
      {body}
    </button>
  )
}

function StoreActionCards(): JSX.Element {
  const { storeOrigin, uploading, uploadError } = useValues(scenesLibraryLogic)
  const { uploadSceneZip } = useActions(scenesLibraryLogic)
  const [open, setOpen] = useState<'ai' | 'zip' | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const newSceneUrl = `${storeOrigin}/my-scenes/new`
  const canUpload = workspaceMode() !== 'frameAdmin'
  return (
    <div className="space-y-3">
      <div className="grid gap-3 @lg:grid-cols-3">
        <ActionCard
          title="Create a scene with AI"
          description="Describe what you want on the display. The assistant builds it in the editor; you tweak it and save it to your scenes."
          icon={<SparklesIcon />}
          tint="gold"
          pressed={open === 'ai'}
          onClick={() => setOpen((current) => (current === 'ai' ? null : 'ai'))}
        />
        <ActionCard
          title="New blank scene"
          description="Start from an empty scene and build it yourself in the editor. The AI panel is there if you want it later."
          icon={<DocumentPlusIcon />}
          tint="slate"
          href={newSceneUrl}
        />
        {canUpload ? (
          <ActionCard
            title="Upload a scene ZIP"
            description={
              workspaceMode() === 'cloud'
                ? 'Upload a scene export. New uploads are private; uploading the same scene name again creates a new version.'
                : 'Upload a scene export into the scenes saved on this backend.'
            }
            icon={<ArrowUpTrayIcon />}
            tint="teal"
            pressed={open === 'zip'}
            onClick={() => setOpen((current) => (current === 'zip' ? null : 'zip'))}
          />
        ) : null}
      </div>
      {open === 'ai' ? (
        <form
          action={newSceneUrl}
          method="get"
          className="frameos-card flex flex-wrap items-center gap-2 rounded-2xl border p-3"
        >
          <input
            name="prompt"
            autoFocus
            maxLength={2000}
            placeholder="A clock with today's weather for Berlin, big text on dark green…"
            className="frameos-input h-11 min-w-0 flex-1 rounded-xl border px-3 text-sm outline-none focus:ring-2 focus:ring-blue-400"
          />
          <button
            type="submit"
            className="frameos-primary-action h-11 rounded-xl px-4 text-sm font-semibold text-white"
          >
            Create with AI
          </button>
        </form>
      ) : null}
      {open === 'zip' && canUpload ? (
        <div className="frameos-card flex flex-wrap items-center gap-3 rounded-2xl border p-3 text-sm">
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            className="min-w-0 flex-1 text-sm"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) {
                uploadSceneZip(file)
              }
            }}
          />
          {uploading ? (
            <span className="frameos-muted flex items-center gap-2">
              <Spinner className="h-4 w-4" />
              Uploading…
            </span>
          ) : null}
          {uploadError ? <span className="text-red-600">{uploadError}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

function StorePage(): JSX.Element {
  const { storeShelves, storeScenesCount, storeTagCounts, repositoriesLoading, search, category, tag } =
    useValues(scenesLibraryLogic)
  const { loadRepositories, setVisibleShelf } = useActions(scenesLibraryLogic)
  const mode = workspaceMode()
  const shelvesRef = useRef<HTMLDivElement>(null)

  // Which shelf is at the top of the viewport, for the side panel. Only on
  // the unfiltered store: a filtered page shows one shelf anyway.
  useEffect(() => {
    if (category || tag) {
      return
    }
    return watchVisibleShelf(shelvesRef.current, setVisibleShelf)
  }, [category, tag, storeShelves.length, setVisibleShelf])
  const goTo = (filters: { category?: string | null; tag?: string | null }) =>
    router.actions.push(urls.scenesHome('store', { category, tag, ...filters }))
  const activeShelf = category ? storeShelfForCategory(category) : null
  return (
    <>
      <PageHeader
        title={activeShelf ? activeShelf.title : 'Scene store'}
        description="Ready-made scenes from the FrameOS community. Open one to see it in the editor, then install it on a frame."
        actions={<RefreshButton onClick={loadRepositories} loading={repositoriesLoading} />}
      />
      <div className="space-y-8" ref={shelvesRef}>
        {tag ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="frameos-muted">Tagged</span>
            <Pill onClick={() => goTo({ tag: null })}>
              {tag}
              <XMarkIcon className="ml-1 h-3 w-3" />
            </Pill>
          </div>
        ) : null}
        {repositoriesLoading && storeScenesCount === 0 ? (
          <div className="frameos-muted flex items-center gap-2 text-sm">
            <Spinner className="h-4 w-4" />
            Loading the scene store…
          </div>
        ) : (
          <StoreShelves
            shelves={storeShelves}
            activeCategory={category}
            shelfHref={(slug) => urls.scenesHome('store', { category: slug })}
            onTag={(value) => goTo({ tag: value.toLowerCase() })}
            emptyMessage={
              storeScenesCount === 0
                ? mode === 'frameAdmin'
                  ? "The scene store could not be reached. Check the frame's connection and try again."
                  : 'The public scene store is not available right now. Check the connection to FrameOS Cloud in Settings.'
                : search
                ? `No store scenes match "${search}".`
                : 'No store scenes match these filters.'
            }
          />
        )}
        <StoreTagCloud tags={storeTagCounts} activeTag={tag} onTag={(value) => goTo({ tag: value })} />
      </div>
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
      <div className="space-y-8">
        {mode === 'cloud' ? <StoreActionCards /> : null}
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
          <TileGrid>
            {drivePageTemplates.map((template) => (
              <SceneTile
                key={template.sceneId ?? template.id ?? template.name}
                template={template}
                showAuthor={false}
                badge={template.visibility === 'public' ? 'Public' : 'Private'}
                badgeTone={template.visibility === 'public' ? 'ok' : undefined}
              />
            ))}
          </TileGrid>
        )}
      </div>
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
      <div className="space-y-8">
        <StoreActionCards />
        {templatesLoading && templates.length === 0 ? (
          <div className="frameos-muted flex items-center gap-2 text-sm">
            <Spinner className="h-4 w-4" />
            Loading saved scenes…
          </div>
        ) : localPageTemplates.length === 0 ? (
          <Note>
            {templates.length === 0
              ? 'No saved scenes yet. Save a scene from a frame with "Save to My scenes", or upload a zip.'
              : `No saved scenes match "${search}".`}
          </Note>
        ) : (
          <TileGrid>
            {localPageTemplates.map((template) => (
              <SceneTile
                key={template.id ?? template.name}
                template={template}
                showAuthor={false}
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
          </TileGrid>
        )}
      </div>
    </>
  )
}

/** The page area for the library page the URL names. */
export function ScenesLibraryPage(): JSX.Element {
  const { page, category, tag } = useValues(scenesLibraryLogic)
  // A new page or filter starts at the top; the scroll position of the
  // previous one would otherwise carry over into the shell's <main>.
  useEffect(() => {
    scrollStoreToTop()
  }, [page, category, tag])
  return (
    <div className="mx-auto max-w-6xl pb-16 @container">
      {page === 'store' ? <StorePage /> : page === 'cloud' ? <CloudScenesPage /> : <LocalScenesPage />}
    </div>
  )
}

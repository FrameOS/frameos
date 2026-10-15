import { useActions, useValues } from 'kea'
import { A, router } from 'kea-router'
import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDownOnSquareIcon,
  ComputerDesktopIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowUpTrayIcon,
  BuildingStorefrontIcon,
  CloudIcon,
  DocumentPlusIcon,
  EllipsisHorizontalIcon,
  FolderIcon,
  PencilSquareIcon,
  SparklesIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'

import { DropdownMenu } from '../../components/DropdownMenu'
import { Modal } from '../../components/Modal'
import { Spinner } from '../../components/Spinner'
import { TextArea } from '../../components/TextArea'
import { TextInput } from '../../components/TextInput'
import type { RepositoryType, TemplateType } from '../../types'
import { urls } from '../../urls'
import { isCloudMode } from '../../utils/cloudMode'
import { storeShelfForCategory } from '../../utils/storeCategories'
import {
  Note,
  SceneTile,
  StoreShelves,
  StoreSortSelect,
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
import { installSceneLogic } from './installSceneLogic'
import { FrameImage } from '../../components/FrameImage'
import { frameHost } from '../../decorators/frame'
import { frameIdsEqual } from '../../utils/frameId'
import { groupFramesByStatus } from '../workspace/frameStatusGroups'
import type { FrameScene, FrameType } from '../../types'
import { InstallSceneModal } from './InstallSceneModal'
import { storeRepositoryOf } from './storeCatalog'
import { WorkspaceSceneDropDown } from '../workspace/WorkspaceSceneDropDown'

// The scenes library: the pages at the top of the Scenes side panel and
// what the page area shows for them — the store front as the cloud's own
// store page draws it (the three ways to a new scene, shelves of small
// tiles), the private scenes the same way. A store or drive
// scene opens on its own page (the template's `url`: the scene page of
// whichever cloud the plane is linked to), which is the full-screen editor
// it has always been; a frame's installed scenes keep the editor here.

const pageIcons: Record<ScenesLibraryPageKey, typeof CloudIcon> = {
  store: BuildingStorefrontIcon,
  cloud: CloudIcon,
  local: FolderIcon,
  installed: ComputerDesktopIcon,
}

/** The frames whose scenes the Installed page lists, active ones first. */
function installedFrames(framesList: FrameType[]): FrameType[] {
  return groupFramesByStatus(framesList)
    .filter((group) => group.key !== 'archived')
    .flatMap((group) => group.frames)
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
  const {
    storeShelfCounts,
    category,
    storeScenesCount,
    visibleShelf,
    driveTemplates,
    hasDriveScope,
    templates,
    visibility,
    framesList,
    frame: frameFilter,
  } = useValues(scenesLibraryLogic)
  const frames = installedFrames(framesList)
  const installedCount = frames.reduce((sum, frame) => sum + (frame.scenes?.length ?? 0), 0)
  const highlightedFrame = frameFilter ?? visibleShelf
  const publishedCount = driveTemplates.filter((template) => template.visibility === 'public').length
  const privateCount = driveTemplates.length - publishedCount
  // On My scenes the highlighted shelf follows the page the same way.
  const highlightedVisibility = visibility ?? visibleShelf
  // On the unfiltered store the highlighted category follows the shelf in view.
  const highlightedCategory = category ?? visibleShelf
  // Each page's count sits at the right of its entry.
  const pageCounts: Record<ScenesLibraryPageKey, number | null> = {
    store: storeScenesCount,
    cloud: hasDriveScope ? driveTemplates.length : null,
    local: templates.length,
    installed: installedCount,
  }
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
                <span className="min-w-0 flex-1 truncate">{scenesLibraryPageLabel(page, mode)}</span>
                {pageCounts[page] !== null ? <span className="frameos-muted text-xs">{pageCounts[page]}</span> : null}
              </A>
              {page === 'installed' && active && frames.length > 0 ? (
                <div className="mt-1 space-y-0.5 pl-6">
                  {frames.map((candidate) => (
                    <SubPageLink
                      key={candidate.id}
                      label={candidate.name || frameHost(candidate)}
                      count={candidate.scenes?.length ?? 0}
                      active={highlightedFrame !== null && frameIdsEqual(highlightedFrame, candidate.id)}
                      href={urls.scenesHome('installed', { frame: candidate.id })}
                    />
                  ))}
                </div>
              ) : null}
              {page === 'cloud' && active && hasDriveScope && driveTemplates.length > 0 ? (
                <div className="mt-1 space-y-0.5 pl-6">
                  {myScenesShelves.map(({ key, title }) => (
                    <SubPageLink
                      key={key}
                      label={title}
                      count={key === 'public' ? publishedCount : privateCount}
                      active={highlightedVisibility === key}
                      href={urls.scenesHome('cloud', { visibility: key })}
                    />
                  ))}
                </div>
              ) : null}
              {page === 'store' && active && storeShelfCounts.length > 0 ? (
                <div className="mt-1 space-y-0.5 pl-6">
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
      {children}
    </div>
  )
}

const myScenesShelves = [
  { key: 'public' as const, title: 'Published in the store', match: (visibility?: string) => visibility === 'public' },
  { key: 'private' as const, title: 'Private scenes', match: (visibility?: string) => visibility !== 'public' },
]

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
  return <SubPageLink label={label} count={count} active={active} href={urls.scenesHome('store', { category: slug })} />
}

function SubPageLink({
  label,
  count,
  active,
  href,
}: {
  label: string
  count: number
  active: boolean
  href: string
}): JSX.Element {
  return (
    <A
      href={href}
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

// The tile's last thing: a way onto a frame. The dialog asks which.
function InstallButton({
  template,
  repository,
}: {
  template: TemplateType
  repository: RepositoryType | null
}): JSX.Element {
  const { openInstall } = useActions(installSceneLogic)
  return (
    <button
      type="button"
      onClick={() => openInstall(template, repository)}
      className="frameos-form-control inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs font-semibold transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      <ArrowDownOnSquareIcon className="h-3.5 w-3.5" />
      Install
    </button>
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
  const { openNewScene } = useActions(installSceneLogic)
  const [open, setOpen] = useState<'ai' | 'zip' | null>(null)
  const [prompt, setPrompt] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  // The cloud's scene pages are the frame-less editor; a backend has none,
  // so a new scene starts on one of its frames (the frame picker).
  const local = !isCloudMode()
  const newSceneUrl = `${storeOrigin}/my-scenes/new`
  const canUpload = workspaceMode() !== 'frameAdmin'
  return (
    <div className="space-y-3">
      <div className="grid gap-3 @lg:grid-cols-3">
        <ActionCard
          title="Create a scene with AI"
          description={
            local
              ? 'Describe what you want on the display. The assistant builds it on a frame of your choice; you tweak it in the editor and save.'
              : 'Describe what you want on the display. The assistant builds it in the editor; you tweak it and save it to your scenes.'
          }
          icon={<SparklesIcon />}
          tint="gold"
          pressed={open === 'ai'}
          onClick={() => setOpen((current) => (current === 'ai' ? null : 'ai'))}
        />
        <ActionCard
          title="New blank scene"
          description={
            local
              ? 'Start from an empty scene on a frame of your choice and build it yourself in the editor.'
              : 'Start from an empty scene and build it yourself in the editor. The AI panel is there if you want it later.'
          }
          icon={<DocumentPlusIcon />}
          tint="slate"
          href={local ? undefined : newSceneUrl}
          onClick={local ? () => openNewScene(null) : undefined}
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
          action={local ? undefined : newSceneUrl}
          method="get"
          onSubmit={
            local
              ? (event) => {
                  event.preventDefault()
                  if (prompt.trim()) {
                    openNewScene(prompt.trim())
                  }
                }
              : undefined
          }
          className="frameos-card flex flex-wrap items-center gap-2 rounded-2xl border p-3"
        >
          <input
            name="prompt"
            autoFocus
            maxLength={2000}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
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
  const { storeShelves, storeScenesCount, repositoriesLoading, search, category, repositories, storeSort } =
    useValues(scenesLibraryLogic)
  const { loadRepositories, setVisibleShelf, setStoreSort } = useActions(scenesLibraryLogic)
  const mode = workspaceMode()
  const shelvesRef = useRef<HTMLDivElement>(null)

  // Which shelf is at the top of the viewport, for the side panel. Only on
  // the unfiltered store: a filtered page shows one shelf anyway.
  useEffect(() => {
    if (category) {
      return
    }
    return watchVisibleShelf(shelvesRef.current, setVisibleShelf)
  }, [category, storeShelves.length, setVisibleShelf])
  const goTo = (filters: { category?: string | null }) =>
    router.actions.push(urls.scenesHome('store', { category, ...filters }))
  const activeShelf = category ? storeShelfForCategory(category) : null
  return (
    <>
      <PageHeader
        title={activeShelf ? activeShelf.title : 'Public scene store'}
        description="Ready-made scenes from the FrameOS community. Open one to see it in the editor, then install it on a frame."
        actions={
          <div className="flex items-center gap-2">
            <StoreSortSelect value={storeSort} onChange={setStoreSort} />
            <RefreshButton onClick={loadRepositories} loading={repositoriesLoading} />
          </div>
        }
      />
      <div className="space-y-8" ref={shelvesRef}>
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
            tileActions={(template) => (
              <InstallButton template={template} repository={storeRepositoryOf(repositories, template)} />
            )}
            emptyMessage={
              storeScenesCount === 0
                ? mode === 'frameAdmin'
                  ? "The scene store could not be reached. Check the frame's connection and try again."
                  : 'The public scene store is not available right now. Check the connection to FrameOS Cloud in Settings.'
                : `No store scenes match "${search}".`
            }
          />
        )}
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
    visibility,
    driveRepository,
  } = useValues(scenesLibraryLogic)
  const { loadDrive, setVisibleShelf } = useActions(scenesLibraryLogic)
  const mode = workspaceMode()
  const title = scenesLibraryPageLabel('cloud', mode)
  const shelvesRef = useRef<HTMLDivElement>(null)
  const shownShelves = visibility ? myScenesShelves.filter((shelf) => shelf.key === visibility) : myScenesShelves
  useEffect(() => {
    if (visibility) {
      return
    }
    return watchVisibleShelf(shelvesRef.current, setVisibleShelf)
  }, [visibility, drivePageTemplates.length, setVisibleShelf])
  const description =
    mode === 'cloud'
      ? 'Your own scenes: the ones you have published to the store, and the ones private to your account.'
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
      <div className="space-y-8" ref={shelvesRef}>
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
          // Two shelves: what the account has published to the store, and
          // what it keeps to itself (or the one the side panel picked).
          shownShelves.map(({ key, title, match }) => {
            const templates = drivePageTemplates.filter((template) => match(template.visibility))
            return templates.length === 0 ? null : (
              <section key={key} data-shelf={key} className="scroll-mt-4 space-y-3">
                <h2 className="frameos-heading flex items-baseline gap-2 text-lg font-bold">
                  {visibility ? (
                    title
                  ) : (
                    <A href={urls.scenesHome('cloud', { visibility: key })} className="hover:underline">
                      {title}
                    </A>
                  )}
                  <span className="frameos-muted text-xs font-medium">{templates.length}</span>
                </h2>
                <TileGrid>
                  {templates.map((template) => (
                    <SceneTile
                      key={template.sceneId ?? template.id ?? template.name}
                      template={template}
                      showAuthor={false}
                      actions={<InstallButton template={template} repository={driveRepository} />}
                    />
                  ))}
                </TileGrid>
              </section>
            )
          })
        )}
      </div>
    </>
  )
}

// A local saved scene's name and description.
function EditLocalSceneModal(): JSX.Element | null {
  const { editTemplateForm, savingTemplate, editTemplateError } = useValues(scenesLibraryLogic)
  const { closeEditTemplate, setEditTemplateValues, saveEditTemplate } = useActions(scenesLibraryLogic)
  if (!editTemplateForm) {
    return null
  }
  const canSave = editTemplateForm.name.trim().length > 0 && !savingTemplate
  return (
    <Modal open onClose={closeEditTemplate} title="Edit scene">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (canSave) {
            saveEditTemplate()
          }
        }}
        className="space-y-4 p-5"
      >
        <label className="block">
          <span className="frameos-muted mb-2 block text-sm font-semibold">Name</span>
          <TextInput
            autoFocus
            value={editTemplateForm.name}
            onChange={(name: string) => setEditTemplateValues({ name })}
          />
        </label>
        <label className="block">
          <span className="frameos-muted mb-2 block text-sm font-semibold">Description</span>
          <TextArea
            rows={4}
            value={editTemplateForm.description}
            onChange={(description: string) => setEditTemplateValues({ description })}
          />
        </label>
        {editTemplateError ? <p className="text-sm text-red-600">{editTemplateError}</p> : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={closeEditTemplate}
            className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSave}
            className="frameos-primary-action flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {savingTemplate ? <Spinner className="h-4 w-4" color="white" /> : null}
            Save
          </button>
        </div>
      </form>
    </Modal>
  )
}

function LocalScenesPage(): JSX.Element {
  const { localPageTemplates, templates, templatesLoading, search } = useValues(scenesLibraryLogic)
  const { exportTemplate, removeTemplate, openEditTemplate } = useActions(scenesLibraryLogic)
  return (
    <>
      <PageHeader
        title={scenesLibraryPageLabel('local')}
        description="Scenes saved on this backend. Install one on a frame, or download it as a zip."
      />
      <EditLocalSceneModal />
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
                      <InstallButton template={template} repository={null} />
                      <DropdownMenu
                        buttonTitle="More"
                        buttonContent={<EllipsisHorizontalIcon className="h-4 w-4" />}
                        buttonColor="none"
                        className="frameos-form-control h-7 w-7 items-center rounded-md border !px-0 !py-0 !shadow-none transition hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-400"
                        items={[
                          {
                            label: 'Edit',
                            icon: <PencilSquareIcon className="h-4 w-4" />,
                            onClick: () => openEditTemplate(template),
                          },
                          {
                            label: 'Download .zip',
                            icon: <ArrowDownTrayIcon className="h-4 w-4" />,
                            onClick: () => exportTemplate(template.id!, 'zip'),
                          },
                          {
                            label: 'Delete',
                            icon: <TrashIcon className="h-4 w-4" />,
                            confirm: `Delete "${template.name}" from this backend?`,
                            onClick: () => removeTemplate(template.id!),
                          },
                        ]}
                      />
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

// A frame's scene: its picture, its name, a way into the editor, and the
// scene's own "..." menu (the one the scenes panel has).
function InstalledSceneTile({ frame, scene }: { frame: FrameType; scene: FrameScene }): JSX.Element {
  return (
    <div className="frameos-card relative flex flex-col gap-2 overflow-hidden rounded-lg border border-white/90 pb-2.5 shadow-lg shadow-slate-300/35 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-slate-300/50 focus-within:ring-2 focus-within:ring-blue-400">
      <A href={urls.scenes(frame.id, scene.id)} className="flex flex-col gap-2 focus:outline-none">
        <FrameImage
          frameId={frame.id}
          sceneId={scene.id}
          thumb
          refreshable={false}
          objectFit="cover"
          className="aspect-[4/3] w-full overflow-hidden bg-slate-800"
          wasmFallback={{ sceneId: scene.id }}
        />
        <div className="px-2.5 pr-10 pt-1">
          <h3 className="frameos-strong text-sm font-semibold leading-tight">{scene.name || 'Untitled scene'}</h3>
          <div className="frameos-muted mt-0.5 text-[11px]">{frame.name || frameHost(frame)}</div>
        </div>
      </A>
      <WorkspaceSceneDropDown
        frame={frame}
        scene={scene}
        scenes={frame.scenes ?? []}
        buttonColor="none"
        className="absolute bottom-2 right-2"
      />
    </div>
  )
}

function InstalledScenesPage(): JSX.Element {
  const { framesList, frame: frameFilter, search } = useValues(scenesLibraryLogic)
  const { setVisibleShelf } = useActions(scenesLibraryLogic)
  const shelvesRef = useRef<HTMLDivElement>(null)
  const frames = installedFrames(framesList)
  const shownFrames = frameFilter ? frames.filter((frame) => frameIdsEqual(frame.id, frameFilter)) : frames
  const focused = frameFilter ? shownFrames[0] ?? null : null
  useEffect(() => {
    if (frameFilter) {
      return
    }
    return watchVisibleShelf(shelvesRef.current, setVisibleShelf)
  }, [frameFilter, frames.length, setVisibleShelf])
  return (
    <>
      <PageHeader
        title={focused ? focused.name || frameHost(focused) : 'Installed scenes'}
        description="Scenes installed on your frames."
      />
      <div className="space-y-8" ref={shelvesRef}>
        {frames.length === 0 ? (
          <Note>
            No frames yet.{' '}
            <A href={urls.frames()} className="font-semibold underline-offset-2 hover:underline">
              Add a frame
            </A>{' '}
            to install scenes on it.
          </Note>
        ) : (
          shownFrames.map((frame) => {
            const scenes = (frame.scenes ?? []).filter(
              (scene) => search === '' || (scene.name ?? '').toLowerCase().includes(search.toLowerCase())
            )
            return (
              <section key={frame.id} data-shelf={String(frame.id)} className="scroll-mt-4 space-y-3">
                {!focused ? (
                  <h2 className="frameos-heading flex items-baseline gap-2 text-lg font-bold">
                    <A href={urls.scenesHome('installed', { frame: frame.id })} className="hover:underline">
                      {frame.name || frameHost(frame)}
                    </A>
                    <span className="frameos-muted text-xs font-medium">{scenes.length}</span>
                  </h2>
                ) : null}
                {scenes.length === 0 ? (
                  <div className="frameos-muted text-sm">
                    {search ? `No scenes match "${search}".` : 'No scenes on this frame yet.'}
                  </div>
                ) : (
                  <TileGrid>
                    {scenes.map((scene) => (
                      <InstalledSceneTile key={scene.id} frame={frame} scene={scene} />
                    ))}
                  </TileGrid>
                )}
              </section>
            )
          })
        )}
      </div>
    </>
  )
}

/** The page area for the library page the URL names. */
export function ScenesLibraryPage(): JSX.Element {
  const { page, category, visibility, frame } = useValues(scenesLibraryLogic)
  // A new page or filter starts at the top; the scroll position of the
  // previous one would otherwise carry over into the shell's <main>.
  useEffect(() => {
    scrollStoreToTop()
  }, [page, category, visibility, frame])
  return (
    <div className="mx-auto max-w-6xl pb-16 @container">
      {page === 'store' ? (
        <StorePage />
      ) : page === 'cloud' ? (
        <CloudScenesPage />
      ) : page === 'installed' ? (
        <InstalledScenesPage />
      ) : (
        <LocalScenesPage />
      )}
      <InstallSceneModal />
    </div>
  )
}

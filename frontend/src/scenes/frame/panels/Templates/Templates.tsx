import { useActions, useValues } from 'kea'
import { Form } from 'kea-forms'
import { H6 } from '../../../../components/H6'
import { frameLogic } from '../../frameLogic'
import { Button } from '../../../../components/Button'
import { isCloudStoreRepository, templatesLogic } from './templatesLogic'
import { groupByStoreShelf } from '../../../../utils/storeCategories'
import { templatesModel } from '../../../../models/templatesModel'
import { TemplateRow } from './Template'
import { Box } from '../../../../components/Box'
import { Field } from '../../../../components/Field'
import { TextInput } from '../../../../components/TextInput'
import { Spinner } from '../../../../components/Spinner'
import { repositoriesModel, repositoryRefreshPending, repositoryUpdatedAt } from '../../../../models/repositoriesModel'
import { TrashIcon, ArrowPathIcon, PlusIcon, ChevronRightIcon, ChevronDownIcon } from '@heroicons/react/24/solid'
import React from 'react'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import copy from 'copy-to-clipboard'
import { ArrowTopRightOnSquareIcon, ClipboardDocumentCheckIcon } from '@heroicons/react/24/outline'
import { RepositoryType, TemplateType } from '../../../../types'
import { isCloudMode } from '../../../../utils/cloudMode'
import { isInFrameAdminMode } from '../../../../utils/frameAdmin'
import { appsModel } from '../../../../models/appsModel'
import { templateCompatibilityForFrame, type CompatibilityResult } from '../../../../utils/embeddedCompatibility'
import { isEsp32Frame } from '../../../workspace/workspaceSurfaces'
import { settingsLogic } from '../../../settings/settingsLogic'
import { templateFavouriteId } from './templateFavourites'
import { CloudDrive } from './CloudDrive'

/** Which half of the scene picker to render. The Add scene drawer shows the
 * two halves on separate pages; 'all' is the old single-page panel. */
export type TemplatesSection = 'store' | 'saved' | 'all'

interface TemplatesProps {
  openInstalledSceneDrawer?: boolean
  section?: TemplatesSection
}

interface CompatibleTemplateRow {
  template: TemplateType
  index: number
  compatibility: CompatibilityResult
}

function sortCompatibleTemplates(a: CompatibleTemplateRow, b: CompatibleTemplateRow): number {
  return a.template.name.localeCompare(b.template.name)
}

/** A repository with no /api/repositories row behind it (the cloud SPA's and
 * the frame's built-in store entry): nothing to refresh or remove. */
function isSystemRepository(repository: RepositoryType): boolean {
  return Boolean(repository.id?.startsWith('system-'))
}

/** The store front to browse the public store in a browser tab: the origin the
 * store's scene pages live on (each template's `url`), which follows a
 * self-hosted provider; scenes.frameos.net when the catalog is empty. */
function storeFrontUrl(repository: RepositoryType): string {
  for (const template of repository.templates ?? []) {
    if (typeof template.url === 'string' && /^https?:\/\//.test(template.url)) {
      try {
        return new URL(template.url).origin + '/'
      } catch {
        // fall through to the default
      }
    }
  }
  return 'https://scenes.frameos.net/'
}

/** "updated 3 h ago" for a repository header; null for built-ins, which never refresh. */
function repositoryUpdatedLabel(repository: RepositoryType, now = Date.now()): string | null {
  if (isSystemRepository(repository)) {
    return null
  }
  if (repositoryRefreshPending(repository, now)) {
    return 'refreshing…'
  }
  const updatedAt = repositoryUpdatedAt(repository)
  if (updatedAt === null) {
    return null
  }
  const minutes = Math.max(0, Math.round((now - updatedAt) / 60000))
  if (minutes < 1) {
    return 'updated just now'
  }
  if (minutes < 60) {
    return `updated ${minutes} min ago`
  }
  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return `updated ${hours} h ago`
  }
  const days = Math.round(hours / 24)
  return `updated ${days} ${days === 1 ? 'day' : 'days'} ago`
}

export function Templates({ openInstalledSceneDrawer = false, section = 'all' }: TemplatesProps = {}) {
  const inFrameAdminMode = isInFrameAdminMode()
  // On the cloud control plane the account's scene library IS the cloud
  // drive and the store catalog is a built-in repository; the self-hosted
  // "Local backend scenes" (/api/templates) and "Add repository"
  // (/api/repositories) surfaces have no server behind them there.
  const cloudMode = isCloudMode()
  const showStore = section !== 'saved'
  const showSaved = section !== 'store'
  const { applyTemplate } = useActions(frameLogic)
  const { frameId, mode, frameForm } = useValues(frameLogic)
  const { apps } = useValues(appsModel)
  const { removeTemplate, exportTemplate } = useActions(templatesModel)
  const {
    applyRemoteToFrame,
    editLocalTemplate,
    saveRemoteAsLocal,
    showRemoteTemplate,
    showUploadTemplate,
    hideRemoteTemplate,
    hideUploadTemplate,
    showAddRepository,
    hideAddRepository,
    toggleExpanded,
    setSearch,
  } = useActions(templatesLogic({ frameId }))
  const {
    repositories,
    hiddenRepositories,
    showingRemoteTemplate,
    showingUploadTemplate,
    showingAddRepository,
    templates,
    isExpanded,
    search,
    installedTemplatesByName,
    installingTemplateIds,
    favouriteTemplateIds,
    storeScenesLoading,
  } = useValues(templatesLogic({ frameId }))
  const { togglePersonalFavouriteTemplate } = useActions(settingsLogic)
  const { removeRepository, refreshRepository } = useActions(repositoriesModel)
  const { addUrlToFrame } = useActions(templatesLogic({ frameId }))
  const { addingUrlToFrame } = useValues(templatesLogic({ frameId }))

  // A pasted URL is an install request, not a search: scene pages on
  // FrameOS Cloud say "copy this link into the Templates search box".
  const searchedUrl = /^https?:\/\/\S+$/i.test(search.trim()) ? search.trim() : null
  // Self-hosted backends can track extra repositories; the frame and the
  // cloud control plane have no /api/repositories to add one to.
  const canAddRepository = !inFrameAdminMode && !cloudMode

  const searchPlaceholder =
    section === 'store'
      ? 'Search the scene store, or paste a scene URL...'
      : section === 'saved'
      ? 'Search private scenes...'
      : 'Search scenes, or paste a scene URL...'

  const addRepository = canAddRepository ? (
    showingAddRepository ? (
      <Box className="frame-tool-card rounded-[22px] p-4">
        <Form
          logic={templatesLogic}
          props={{ frameId }}
          formKey="addRepositoryForm"
          enableFormOnSubmit
          className="space-y-3"
        >
          <H6>Add scenes repository</H6>
          <div className="frame-tool-muted text-sm">
            Use a FrameOS repository JSON URL. Its scenes are listed here once imported.{' '}
            <a href="https://github.com/FrameOS/repo" target="_blank" rel="noreferrer" className="underline">
              Repository format
            </a>
          </div>
          <Field label="" name="url">
            <TextInput placeholder="https://repo.frameos.net/samples/repository.json" />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="small" color="primary">
              Add repository
            </Button>
            <Button size="small" color="secondary" onClick={hideAddRepository}>
              Close
            </Button>
          </div>
        </Form>
      </Box>
    ) : (
      <Button size="small" color="secondary" className="flex gap-1 items-center" onClick={showAddRepository}>
        <PlusIcon className="w-4 h-4" />
        Add repository
      </Button>
    )
  ) : null

  // The Scene store page is the FrameOS Cloud store alone. Repositories the
  // user added are listed on the Private scenes page, next to the button that
  // adds them.
  const storeRepositories = repositories.filter(isCloudStoreRepository)
  const addedRepositories = repositories.filter((repository) => !isCloudStoreRepository(repository))

  const renderRepository = (repository: RepositoryType): JSX.Element => {
    const systemRepository = isSystemRepository(repository)
    const cloudStore = isCloudStoreRepository(repository)
    const updatedLabel = repositoryUpdatedLabel(repository)
    const menu = !inFrameAdminMode ? (
      <DropdownMenu
        buttonColor="secondary"
        className="mr-3"
        items={[
          ...(!systemRepository
            ? [
                {
                  label: 'Refresh',
                  onClick: () => repository.id && refreshRepository(repository.id),
                  icon: <ArrowPathIcon className="w-5 h-5" />,
                  title: `Last refresh: ${repository.last_updated_at}`,
                },
              ]
            : []),
          {
            label: 'Copy repository URL',
            title: repository.url,
            onClick: async () => repository.url && copy(repository.url),
            icon: <ClipboardDocumentCheckIcon className="w-5 h-5" />,
          },
          ...(!systemRepository
            ? [
                {
                  label: 'Remove',
                  onClick: () => repository.id && removeRepository(repository.id),
                  icon: <TrashIcon className="w-5 h-5" />,
                },
              ]
            : []),
        ]}
      />
    ) : null
    const rows = (repository.templates ?? [])
      .map((template, index) => ({
        template,
        index,
        compatibility: templateCompatibilityForFrame(mode, template, apps, frameForm),
      }))
      // A microcontroller can never run these (shell apps,
      // compiled-only nodes, …) — on ESP32 an unsupported row
      // is pure noise, so hide it instead of graying it out.
      // Fuller platforms keep the row with its reason.
      .filter(({ compatibility }) => compatibility.supported || !isEsp32Frame(frameForm))
      .toSorted(sortCompatibleTemplates)
    const renderRow = ({ template, index, compatibility }: CompatibleTemplateRow): JSX.Element => {
      const favouriteId = templateFavouriteId(template, repository)
      return (
        <TemplateRow
          key={template.id ?? -index}
          template={template}
          frameId={frameId}
          repository={repository}
          favourite={favouriteTemplateIds.has(favouriteId)}
          favouriteId={favouriteId}
          onToggleFavourite={togglePersonalFavouriteTemplate}
          saveRemoteAsLocal={!inFrameAdminMode ? (template) => saveRemoteAsLocal(repository, template) : undefined}
          applyTemplate={(template) => {
            applyRemoteToFrame(repository, template, openInstalledSceneDrawer)
          }}
          installedTemplatesByName={installedTemplatesByName}
          installing={Boolean(installingTemplateIds[favouriteId])}
          templateDragData={
            compatibility.supported
              ? {
                  template,
                  repository: {
                    id: repository.id,
                    name: repository.name,
                    url: repository.url,
                  },
                }
              : undefined
          }
          compatibility={compatibility}
        />
      )
    }

    if (cloudStore) {
      // The public store is one catalog split into the same shelves
      // as the store front (utils/storeCategories), each shelf its
      // own collapsible section. The repository itself is reduced
      // to a status line: how many scenes, how fresh, and the menu.
      const shelves = groupByStoreShelf(rows.map((row) => ({ ...row, category: row.template.category })))
      return (
        <div className="space-y-6 !mt-6" key={repository.id}>
          <div className="flex items-start justify-between gap-2">
            <div className="frame-tool-muted min-w-0 break-words text-sm">
              {repository.name || 'FrameOS Cloud store'}
              {rows.length ? ` · ${rows.length} ${rows.length === 1 ? 'scene' : 'scenes'}` : ''}
              {updatedLabel ? ` · ${updatedLabel}` : ''}
              {' · '}
              <a
                href={storeFrontUrl(repository)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline"
              >
                scenes.frameos.net
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
              </a>
            </div>
            {menu}
          </div>
          {shelves.map(({ shelf, templates: shelfRows }) => {
            const expandedKey = `${repository.url}#${shelf.slug}`
            const expanded = isExpanded(expandedKey)
            return (
              <div className="space-y-2" key={shelf.slug}>
                <H6
                  className="flex cursor-pointer flex-wrap items-center gap-x-1"
                  onClick={() => toggleExpanded(expandedKey)}
                >
                  {expanded ? <ChevronDownIcon className="w-6 h-6" /> : <ChevronRightIcon className="w-6 h-6" />}
                  {shelf.title}
                  {` (${shelfRows.length})`}
                </H6>
                {expanded ? <div className="space-y-2">{shelfRows.map(renderRow)}</div> : null}
              </div>
            )
          })}
          {rows.length === 0 ? (
            <div className="frame-tool-muted rounded-xl px-3 py-2 text-sm">
              {search === ''
                ? 'The scene store has no scenes for this frame yet.'
                : `No store scenes match "${search}"`}
            </div>
          ) : null}
        </div>
      )
    }

    return (
      <div className="space-y-2 !mt-8" key={repository.id}>
        <div className="flex gap-2 items-start justify-between">
          <H6
            className="flex min-w-0 cursor-pointer flex-wrap items-center gap-x-1 break-words"
            onClick={() => toggleExpanded(repository.url)}
          >
            {isExpanded(repository.url) ? (
              <ChevronDownIcon className="w-6 h-6" />
            ) : (
              <ChevronRightIcon className="w-6 h-6" />
            )}
            {repository.name || repository.url}
            {repository.templates?.length ? ` (${repository.templates.length})` : ''}
            {updatedLabel ? (
              <span className="frame-tool-muted text-xs font-normal normal-case tracking-normal">· {updatedLabel}</span>
            ) : null}
          </H6>
          {menu}
        </div>
        {isExpanded(repository.url) && repository.description ? (
          <div className="frame-tool-muted break-words text-sm">{repository.description}</div>
        ) : null}
        {isExpanded(repository.url) && repository.templates ? (
          <div className="space-y-2">{rows.map(renderRow)}</div>
        ) : null}
        {isExpanded(repository.url) && repository.templates?.length === 0 ? (
          <div className="frame-tool-muted rounded-xl px-3 py-2 text-sm">This repository has no scenes.</div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="frame-tool-panel space-y-4">
      <TextInput placeholder={searchPlaceholder} onChange={setSearch} value={search} />
      {showStore && searchedUrl && !inFrameAdminMode ? (
        <Box className="frame-tool-card space-y-2 rounded-[22px] p-4">
          <H6>Install scene from URL</H6>
          <div className="frame-tool-muted break-all text-sm">{searchedUrl}</div>
          <Button
            size="small"
            color="primary"
            disabled={addingUrlToFrame}
            onClick={() => addUrlToFrame(searchedUrl, openInstalledSceneDrawer)}
          >
            {addingUrlToFrame ? 'Installing…' : 'Install on this frame'}
          </Button>
        </Box>
      ) : null}
      {showSaved && showingRemoteTemplate ? (
        <Box className="frame-tool-card space-y-3 rounded-[22px] p-4">
          <H6>Add scene from URL</H6>
          <Form
            logic={templatesLogic}
            props={{ frameId }}
            formKey="addTemplateUrlForm"
            enableFormOnSubmit
            className="space-y-2"
          >
            <Field label="" name="url">
              <TextInput placeholder="https://url/to/template.zip" />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" size="small" color="primary">
                Add template
              </Button>
              <Button color="secondary" size="small" onClick={hideRemoteTemplate}>
                Cancel
              </Button>
            </div>
          </Form>
        </Box>
      ) : null}
      {showSaved && showingUploadTemplate ? (
        <Box className="frame-tool-card space-y-3 rounded-[22px] p-4">
          <H6>Upload scene bundle</H6>
          <Form
            logic={templatesLogic}
            props={{ frameId }}
            formKey="uploadTemplateForm"
            enableFormOnSubmit
            className="space-y-2"
          >
            <Field label="" name="file">
              {({ onChange }) => (
                <input
                  type="file"
                  accept=".zip"
                  className="block w-full cursor-pointer rounded-lg border border-slate-500/20 text-sm file:mr-3 file:border-0 file:bg-slate-500/10 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-inherit hover:file:bg-slate-500/15"
                  onChange={(e: React.FormEvent<HTMLInputElement>) => {
                    const target = e.target as HTMLInputElement & {
                      files: FileList
                    }
                    onChange(target.files[0])
                  }}
                />
              )}
            </Field>
            <div className="flex gap-2">
              <Button type="submit" size="small" color="primary">
                Upload template
              </Button>
              <Button color="secondary" size="small" onClick={hideUploadTemplate}>
                Cancel
              </Button>
            </div>
          </Form>
        </Box>
      ) : null}

      {showSaved && !inFrameAdminMode && <CloudDrive openInstalledSceneDrawer={openInstalledSceneDrawer} />}

      {showSaved && !inFrameAdminMode && !cloudMode && (
        <div className="space-y-2 !mt-8">
          <div className="flex justify-between w-full items-center">
            <H6 className="flex cursor-pointer items-center gap-1" onClick={() => toggleExpanded('')}>
              {isExpanded('') ? <ChevronDownIcon className="w-6 h-6" /> : <ChevronRightIcon className="w-6 h-6" />}
              Local backend scenes
              {templates.length ? ` (${templates.length})` : ''}
            </H6>
            <DropdownMenu
              buttonColor="secondary"
              className="mr-3"
              items={[
                {
                  label: 'Add template from URL',
                  onClick: showRemoteTemplate,
                  icon: <PlusIcon className="w-5 h-5" />,
                },
                {
                  label: 'Upload template .zip',
                  onClick: showUploadTemplate,
                  icon: <ArrowPathIcon className="w-5 h-5" />,
                },
              ]}
            />
          </div>
          {isExpanded('') && (
            <div className="space-y-2">
              {templates
                .map((template, index) => ({
                  template,
                  index,
                  compatibility: templateCompatibilityForFrame(mode, template, apps, frameForm),
                }))
                .toSorted(sortCompatibleTemplates)
                .map(({ template, index, compatibility }) => {
                  const favouriteId = templateFavouriteId(template)
                  return (
                    <TemplateRow
                      key={template.id ?? -index}
                      template={template}
                      frameId={frameId}
                      favourite={favouriteTemplateIds.has(favouriteId)}
                      favouriteId={favouriteId}
                      onToggleFavourite={togglePersonalFavouriteTemplate}
                      exportTemplate={exportTemplate}
                      removeTemplate={removeTemplate}
                      applyTemplate={(template: TemplateType) => {
                        applyTemplate(template, openInstalledSceneDrawer)
                      }}
                      editTemplate={editLocalTemplate}
                      installedTemplatesByName={installedTemplatesByName}
                      templateDragData={compatibility.supported ? { template } : undefined}
                      compatibility={compatibility}
                    />
                  )
                })}
            </div>
          )}
          {isExpanded('') && templates.length === 0 ? (
            <div className="frame-tool-muted rounded-xl px-3 py-2 text-sm">
              {search === '' ? 'You have no local backend scenes.' : `No local backend scenes match "${search}"`}
            </div>
          ) : null}
        </div>
      )}

      {section === 'saved' && canAddRepository ? (
        <div className="space-y-2 !mt-8">
          <H6>
            Scene repositories
            {addedRepositories.length ? ` (${addedRepositories.length})` : ''}
          </H6>
          <div className="frame-tool-muted text-sm">
            Other catalogs of scenes, in the FrameOS repository JSON format. Their scenes are listed here.
          </div>
          {addedRepositories.map(renderRepository)}
          {addedRepositories.length === 0 && search !== '' && hiddenRepositories > 0 ? (
            <div className="frame-tool-muted rounded-xl px-3 py-2 text-sm">No repositories match "{search}".</div>
          ) : null}
          {addRepository}
        </div>
      ) : null}

      {showStore ? (
        <>
          {storeScenesLoading ? (
            <div className="frame-tool-muted flex items-center gap-2 rounded-xl px-3 py-2 text-sm">
              <Spinner className="h-4 w-4" />
              Loading the scene store…
            </div>
          ) : null}
          {storeRepositories.map(renderRepository)}
          {storeRepositories.length === 0 && !storeScenesLoading ? (
            <div className="space-y-2">
              <H6>Scene store</H6>
              <div className="frame-tool-muted text-sm">
                {inFrameAdminMode
                  ? "The scene store could not be reached. Check the frame's connection and try again."
                  : search !== ''
                  ? `No store scenes match "${search}".`
                  : 'The public scene store is not available right now. Check the connection to FrameOS Cloud in Settings.'}
              </div>
            </div>
          ) : null}
          {section === 'all' ? addedRepositories.map(renderRepository) : null}
          {section === 'all' ? addRepository : null}
        </>
      ) : null}
    </div>
  )
}

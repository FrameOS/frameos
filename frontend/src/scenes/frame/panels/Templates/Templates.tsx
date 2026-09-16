import { useActions, useValues } from 'kea'
import { Form } from 'kea-forms'
import { H6 } from '../../../../components/H6'
import { frameLogic } from '../../frameLogic'
import { Button } from '../../../../components/Button'
import { templatesLogic } from './templatesLogic'
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
import { ClipboardDocumentCheckIcon } from '@heroicons/react/24/outline'
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

function isSystemRepository(repository: RepositoryType): boolean {
  return Boolean(repository.id?.startsWith('system-') || repository.url?.startsWith('/api/repositories/system/'))
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
  // "My local scenes" (/api/templates) and "Add repository"
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
      ? 'Search saved scenes...'
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
            Use a FrameOS repository JSON URL. Its scenes show up under{' '}
            <span className="frameos-strong font-semibold">Scene store</span> after import.{' '}
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
              My local scenes
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
              {search === '' ? 'You have no saved scenes.' : `No saved scenes match "${search}"`}
            </div>
          ) : null}
        </div>
      )}

      {section === 'saved' && addRepository ? (
        <div className="space-y-2 !mt-8">
          <H6>Scene repositories</H6>
          <div className="frame-tool-muted text-sm">
            Track another catalog of scenes alongside the store. Repositories you add are listed under{' '}
            <span className="frameos-strong font-semibold">Scene store</span>.
          </div>
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
          {(repositories ?? []).map((repository) => {
            const systemRepository = isSystemRepository(repository)
            const updatedLabel = repositoryUpdatedLabel(repository)
            return (
              <div className="space-y-2 !mt-8" key={repository.id}>
                <div className="flex gap-2 items-start justify-between">
                  <H6
                    className="flex cursor-pointer flex-wrap items-center gap-x-1"
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
                      <span className="frame-tool-muted text-xs font-normal normal-case tracking-normal">
                        · {updatedLabel}
                      </span>
                    ) : null}
                  </H6>
                  {!inFrameAdminMode ? (
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
                  ) : null}
                </div>
                {isExpanded(repository.url) && repository.description ? (
                  <div className="frame-tool-muted text-sm">{repository.description}</div>
                ) : null}
                {isExpanded(repository.url) && repository.templates ? (
                  <div className="space-y-2">
                    {repository.templates
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
                      .map(({ template, index, compatibility }) => {
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
                            saveRemoteAsLocal={
                              !inFrameAdminMode ? (template) => saveRemoteAsLocal(repository, template) : undefined
                            }
                            applyTemplate={(template) => {
                              applyRemoteToFrame(repository, template, openInstalledSceneDrawer)
                            }}
                            installedTemplatesByName={installedTemplatesByName}
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
                      })}
                  </div>
                ) : null}
                {isExpanded(repository.url) && repository.templates?.length === 0 ? (
                  <div className="frame-tool-muted rounded-xl px-3 py-2 text-sm">This repository has no scenes.</div>
                ) : null}
              </div>
            )
          })}
          {!inFrameAdminMode ? (
            <>
              {(repositories.length === 0 && !storeScenesLoading) || hiddenRepositories > 0 ? (
                <div className="space-y-2">
                  {repositories.length === 0 ? <H6>Scene store</H6> : null}
                  <div className="frame-tool-muted text-sm">
                    {hiddenRepositories > 0 ? (
                      <>
                        {hiddenRepositories} {hiddenRepositories === 1 ? 'repository' : 'repositories'} had no match for
                        "{search}".
                      </>
                    ) : canAddRepository && section === 'store' ? (
                      <>
                        No scene repositories yet. Connect FrameOS Cloud in Settings for the public store, or add a
                        repository under <span className="frameos-strong font-semibold">Saved scenes</span>.
                      </>
                    ) : (
                      <>You have no repositories installed.</>
                    )}
                  </div>
                </div>
              ) : null}
              {section === 'all' ? addRepository : null}
            </>
          ) : repositories.length === 0 && !storeScenesLoading ? (
            <div className="space-y-2">
              <H6>Bundled scenes</H6>
              <div className="frame-tool-muted text-sm">No bundled scenes are available.</div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

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
import { repositoriesModel } from '../../../../models/repositoriesModel'
import { TrashIcon, ArrowPathIcon, PlusIcon, ChevronRightIcon, ChevronDownIcon } from '@heroicons/react/24/solid'
import React from 'react'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import copy from 'copy-to-clipboard'
import { ClipboardDocumentCheckIcon } from '@heroicons/react/24/outline'
import { TemplateType } from '../../../../types'
import { isInFrameAdminMode } from '../../../../utils/frameAdmin'
import { appsModel } from '../../../../models/appsModel'
import { templateCompatibilityForFrame, type CompatibilityResult } from '../../../../utils/embeddedCompatibility'
import { settingsLogic } from '../../../settings/settingsLogic'
import { templateFavouriteId } from './templateFavourites'

interface TemplatesProps {
  openInstalledSceneDrawer?: boolean
  persistOnInstall?: boolean
}

interface CompatibleTemplateRow {
  template: TemplateType
  index: number
  compatibility: CompatibilityResult
}

function sortCompatibleTemplates(a: CompatibleTemplateRow, b: CompatibleTemplateRow): number {
  if (a.compatibility.supported !== b.compatibility.supported) {
    return a.compatibility.supported ? -1 : 1
  }
  return a.template.name.localeCompare(b.template.name)
}

export function Templates({ openInstalledSceneDrawer = false, persistOnInstall = false }: TemplatesProps = {}) {
  const inFrameAdminMode = isInFrameAdminMode()
  const { applyTemplate, applyTemplateAndSave } = useActions(frameLogic)
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
  } = useValues(templatesLogic({ frameId }))
  const { togglePersonalFavouriteTemplate } = useActions(settingsLogic)
  const { removeRepository, refreshRepository } = useActions(repositoriesModel)

  return (
    <div className="frame-tool-panel space-y-4">
      <TextInput placeholder="Search scenes..." onChange={setSearch} value={search} />
      {showingRemoteTemplate ? (
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
      {showingUploadTemplate ? (
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

      {!inFrameAdminMode && (
        <div className="space-y-2">
          <div className="flex justify-between w-full items-center">
            <H6 className="flex cursor-pointer items-center gap-1" onClick={() => toggleExpanded('')}>
              {isExpanded('') ? <ChevronDownIcon className="w-6 h-6" /> : <ChevronRightIcon className="w-6 h-6" />}
              My scenes
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
                        if (persistOnInstall) {
                          applyTemplateAndSave(template, openInstalledSceneDrawer)
                        } else {
                          applyTemplate(template)
                        }
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

      {!inFrameAdminMode && (
        <>
          {(repositories ?? []).map((repository) => (
            <div className="space-y-2 !mt-8" key={repository.id}>
              <div className="flex gap-2 items-start justify-between">
                <H6 className="flex cursor-pointer items-center gap-1" onClick={() => toggleExpanded(repository.url)}>
                  {isExpanded(repository.url) ? (
                    <ChevronDownIcon className="w-6 h-6" />
                  ) : (
                    <ChevronRightIcon className="w-6 h-6" />
                  )}
                  {repository.name || repository.url}
                  {repository.templates?.length ? ` (${repository.templates.length})` : ''}
                </H6>
                <DropdownMenu
                  buttonColor="secondary"
                  className="mr-3"
                  items={[
                    {
                      label: 'Refresh',
                      onClick: () => repository.id && refreshRepository(repository.id),
                      icon: <ArrowPathIcon className="w-5 h-5" />,
                      title: `Last refresh: ${repository.last_updated_at}`,
                    },
                    {
                      label: 'Copy repository URL',
                      title: repository.url,
                      onClick: async () => repository.url && copy(repository.url),
                      icon: <ClipboardDocumentCheckIcon className="w-5 h-5" />,
                    },
                    {
                      label: 'Remove',
                      onClick: () => repository.id && removeRepository(repository.id),
                      icon: <TrashIcon className="w-5 h-5" />,
                    },
                  ]}
                />
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
                    .toSorted(sortCompatibleTemplates)
                    .map(({ template, index, compatibility }) => {
                      const favouriteId = templateFavouriteId(template, repository)
                      return (
                        <TemplateRow
                          key={template.id ?? -index}
                          template={template}
                          frameId={frameId}
                          favourite={favouriteTemplateIds.has(favouriteId)}
                          favouriteId={favouriteId}
                          onToggleFavourite={togglePersonalFavouriteTemplate}
                          saveRemoteAsLocal={(template) => saveRemoteAsLocal(repository, template)}
                          applyTemplate={(template) => {
                            applyRemoteToFrame(
                              repository,
                              template,
                              persistOnInstall,
                              persistOnInstall && openInstalledSceneDrawer
                            )
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
          ))}
          {repositories.length === 0 || hiddenRepositories > 0 ? (
            <div className="space-y-2">
              {repositories.length === 0 ? <H6>Remote repositories</H6> : null}
              <div className="frame-tool-muted text-sm">
                {hiddenRepositories > 0 ? (
                  <>
                    {hiddenRepositories} {hiddenRepositories === 1 ? 'repository' : 'repositories'} had no match for "
                    {search}".
                  </>
                ) : (
                  <>You have no repositories installed.</>
                )}
              </div>
            </div>
          ) : null}
          {showingAddRepository ? (
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
                  Use a FrameOS repository JSON URL. Repository scenes appear in this drawer after import.{' '}
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
          )}
        </>
      )}
    </div>
  )
}

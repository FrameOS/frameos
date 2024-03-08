import { useActions, useValues } from 'kea'
import { Form } from 'kea-forms'
import { H6 } from '../../../../components/H6'
import { frameLogic } from '../../frameLogic'
import { Button } from '../../../../components/Button'
import { templatesLogic } from './templatesLogic'
import { templatesModel } from '../../../../models/templatesModel'
import { Template } from './Template'
import { Box } from '../../../../components/Box'
import { Field } from '../../../../components/Field'
import { TextInput } from '../../../../components/TextInput'
import { repositoriesModel } from '../../../../models/repositoriesModel'
import { TrashIcon, ArrowPathIcon, PlusIcon } from '@heroicons/react/24/solid'
import React from 'react'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import copy from 'copy-to-clipboard'
import { ArchiveBoxIcon, ClipboardDocumentCheckIcon } from '@heroicons/react/24/outline'

export function Templates() {
  const { applyTemplate } = useActions(frameLogic)
  const { frameId, frameForm } = useValues(frameLogic)
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
    saveAsLocalTemplate,
    setSearch,
  } = useActions(templatesLogic({ frameId }))
  const {
    repositories,
    hiddenRepositories,
    showingRemoteTemplate,
    showingUploadTemplate,
    showingAddRepository,
    templates,
    search,
  } = useValues(templatesLogic({ frameId }))
  const { removeRepository, refreshRepository } = useActions(repositoriesModel)

  return (
    <div className="space-y-4">
      <TextInput placeholder="Search templates..." onChange={setSearch} value={search} />
      <div className="space-y-2">
        <div className="flex justify-between w-full items-center">
          <H6>Local templates (in this server)</H6>
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
              {
                label: 'Export frame as template',
                onClick: () => saveAsLocalTemplate({ name: frameForm.name }),
                icon: <ArchiveBoxIcon className="w-5 h-5" />,
              },
            ]}
          />
        </div>
        {showingRemoteTemplate ? (
          <Box className="p-4 space-y-2 bg-gray-900">
            <H6>Add template from URL</H6>
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
          <Box className="p-4 space-y-2 bg-gray-900">
            <H6>Upload template</H6>
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
        {templates.map((template) => (
          <Template
            template={template}
            exportTemplate={exportTemplate}
            removeTemplate={removeTemplate}
            applyTemplate={applyTemplate}
            editTemplate={editLocalTemplate}
          />
        ))}
        {templates.length === 0 ? (
          <div className="text-muted">
            {search === '' ? 'You have no local templates.' : 'No local templates match the search'}
          </div>
        ) : null}
      </div>
      {(repositories ?? []).map((repository) => (
        <div className="space-y-2 !mt-8">
          <div className="flex gap-2 items-start justify-between">
            <H6>{repository.name}</H6>
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
          {(repository.templates || []).map((template) => (
            <Template
              template={template}
              saveRemoteAsLocal={(template) => saveRemoteAsLocal(repository, template)}
              applyTemplate={(template, replace) => {
                applyRemoteToFrame(repository, template, replace)
              }}
            />
          ))}
          {repository.templates?.length === 0 ? (
            <div className="text-muted">This repository has no templates.</div>
          ) : null}
        </div>
      ))}
      {repositories.length === 0 || hiddenRepositories > 0 ? (
        <div className="space-y-2">
          {repositories.length === 0 ? <H6>Remote repositories</H6> : null}
          <div>
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
        <Box className="p-4 bg-gray-900">
          <Form
            logic={templatesLogic}
            props={{ frameId }}
            formKey="addRepositoryForm"
            enableFormOnSubmit
            className="space-y-2"
          >
            <H6>Add templates repository</H6>
            <div>
              Read more about creating repositories{' '}
              <a href="https://github.com/FrameOS/repo" target="_blank" rel="noreferrer" className="underline">
                here.
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
    </div>
  )
}

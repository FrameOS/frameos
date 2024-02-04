import { useActions, useValues } from 'kea'
import { Form } from 'kea-forms'
import { H6 } from '../../../../components/H6'
import { frameLogic } from '../../frameLogic'
import { Button } from '../../../../components/Button'
import { templatesLogic } from './templatesLogic'
import { templatesModel } from '../../../../models/templatesModel'
import { Template } from './Template'
import { EditTemplate } from './EditTemplate'
import { Box } from '../../../../components/Box'
import { Field } from '../../../../components/Field'
import { TextInput } from '../../../../components/TextInput'
import { repositoriesModel } from '../../../../models/repositoriesModel'
import { TrashIcon, ArrowPathIcon, ClipboardIcon } from '@heroicons/react/24/solid'
import React from 'react'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import copy from 'copy-to-clipboard'

export function Templates() {
  const { applyTemplate } = useActions(frameLogic)
  const { frameId } = useValues(frameLogic)
  const { templates } = useValues(templatesModel)
  const { removeTemplate, exportTemplate } = useActions(templatesModel)
  const { saveAsNewTemplate, editLocalTemplate, applyRemoteTemplate } = useActions(templatesLogic({ frameId }))
  const { repositories } = useValues(repositoriesModel)
  const { removeRepository, refreshRepository } = useActions(repositoriesModel)

  return (
    <>
      <div className="space-y-2 float-right">
        <Button size="small" onClick={saveAsNewTemplate}>
          Save as template...
        </Button>
        <EditTemplate />
      </div>
      <div className="space-y-8">
        <div className="space-y-2">
          <H6>Local templates</H6>
          {templates.map((template) => (
            <Template
              template={template}
              exportTemplate={exportTemplate}
              removeTemplate={removeTemplate}
              applyTemplate={applyTemplate}
              editTemplate={editLocalTemplate}
            />
          ))}
          {templates.length === 0 ? <div className="text-muted">You have no local templates.</div> : null}
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
              <Button type="submit" color="secondary">
                Add template
              </Button>
            </Form>
          </Box>
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
              <Button type="submit" color="secondary">
                Upload template
              </Button>
            </Form>
          </Box>
        </div>
        {(repositories ?? []).map((repository) => (
          <div className="space-y-2">
            <div className="flex gap-2 items-start justify-between">
              <H6>{repository.name}</H6>
              <div className="flex gap-2">
                <DropdownMenu
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
                      icon: <ClipboardIcon className="w-5 h-5" />,
                    },
                    {
                      label: 'Remove',
                      onClick: () => repository.id && removeRepository(repository.id),
                      icon: <TrashIcon className="w-5 h-5" />,
                    },
                  ]}
                />
              </div>
            </div>
            <div className="text-sm whitespace-nowrap p-2 overflow-x-auto bg-black text-white">{repository.url}</div>
            {(repository.templates || []).map((template) => (
              <Template template={template} applyTemplate={(template) => applyRemoteTemplate(repository, template)} />
            ))}
            {repository.templates?.length === 0 ? (
              <div className="text-muted">This repository has no templates.</div>
            ) : null}
          </div>
        ))}
        <div className="space-y-2">
          <H6>Add repository</H6>
          <Box className="p-4 space-y-2 bg-gray-900">
            <Form
              logic={templatesLogic}
              props={{ frameId }}
              formKey="addRepositoryForm"
              enableFormOnSubmit
              className="space-y-2"
            >
              <Field label="" name="name">
                <TextInput placeholder="Official goods" />
              </Field>
              <Field label="" name="url">
                <TextInput placeholder="https://url/to/templates.json" />
              </Field>
              <Button type="submit" color="secondary">
                Add repository
              </Button>
            </Form>
          </Box>
        </div>
      </div>
    </>
  )
}

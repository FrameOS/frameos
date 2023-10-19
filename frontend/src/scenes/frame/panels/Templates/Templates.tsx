import { useActions, useValues } from 'kea'
import { Form } from 'kea-forms'
import { H6 } from '../../../../components/H6'
import { frameLogic } from '../../frameLogic'
import { Button } from '../../../../components/Button'
import globalTemplates from '../../../../templates.json'
import { templatesLogic } from './templatesLogic'
import { templatesModel } from '../../../../models/templatesModel'
import { TemplateType } from '../../../../types'
import { Template } from './Template'
import { EditTemplate } from './EditTemplate'
import { Box } from '../../../../components/Box'
import { Field } from '../../../../components/Field'
import { TextInput } from '../../../../components/TextInput'

export function Templates() {
  const { applyTemplate } = useActions(frameLogic)
  const { id } = useValues(frameLogic)
  const { templates } = useValues(templatesModel)
  const { removeTemplate, exportTemplate } = useActions(templatesModel)
  const { saveAsNewTemplate, editLocalTemplate } = useActions(templatesLogic({ id }))
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
              props={{ id }}
              formKey="addTemplateUrlForm"
              enableFormOnSubmit
              className="space-y-2"
            >
              <Field label="" name="url">
                <TextInput placeholder="https://url/to/template.zip" />
              </Field>
              <Button type="submit" color="light-gray">
                Add template
              </Button>
            </Form>
          </Box>
          <Box className="p-4 space-y-2 bg-gray-900">
            <H6>Upload template</H6>
            <Form
              logic={templatesLogic}
              props={{ id }}
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
              <Button type="submit" color="light-gray">
                Upload template
              </Button>
            </Form>
          </Box>
        </div>
        <div className="space-y-2">
          <H6>Official templates</H6>
          {(globalTemplates as TemplateType[]).map((template) => (
            <Template template={template} applyTemplate={applyTemplate} />
          ))}
        </div>
      </div>
    </>
  )
}

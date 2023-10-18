import { useActions, useValues } from 'kea'
import { Box } from '../../../../components/Box'
import { H6 } from '../../../../components/H6'
import { frameLogic } from '../../frameLogic'
import { Button } from '../../../../components/Button'
import globalTemplates from '../../../../templates.json'
import { templatesLogic } from './templatesLogic'
import { templatesModel } from '../../../../models/templatesModel'
import { TemplateType } from '../../../../types'
import { Template } from './Template'
import { EditTemplate } from './EditTemplate'

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
          Save as template
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
        </div>
        <div className="space-y-2">
          <H6>Official templates</H6>
          {globalTemplates.map((template) => (
            <Box className="bg-gray-900 px-3 py-2 dndnode space-y-2">
              <div className="flex items-center justify-between">
                <H6>{template.name}</H6>
                <Button
                  size="small"
                  color="light-gray"
                  onClick={() => {
                    if (confirm(`Are you sure you want to replace the scene with the "${template.name}" template?`)) {
                      applyTemplate(template as TemplateType)
                    }
                  }}
                >
                  Replace
                </Button>
              </div>
              <div className="text-gray-400 text-sm">{template.description}</div>
            </Box>
          ))}
        </div>
      </div>
    </>
  )
}

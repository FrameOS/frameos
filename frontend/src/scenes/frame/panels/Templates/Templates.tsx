import { useActions, useValues } from 'kea'
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

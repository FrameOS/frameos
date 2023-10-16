import { useActions, useValues } from 'kea'
import { Box } from '../../../../components/Box'
import { H6 } from '../../../../components/H6'
import { frameLogic } from '../../frameLogic'
import { Button } from '../../../../components/Button'
import globalTemplates from '../../../../templates.json'
import { Modal } from '../../../../components/Modal'
import { templatesLogic } from './templatesLogic'
import { Form } from 'kea-forms'
import { TextInput } from '../../../../components/TextInput'
import { Field } from '../../../../components/Field'
import { TextArea } from '../../../../components/TextArea'
import { Image } from '../Image/Image'
import { templatesModel } from '../../../../models/templatesModel'
import { TemplateType } from '../../../../types'

export function Templates() {
  const { setFrameFormValues, applyTemplate } = useActions(frameLogic)
  const { id, frameFormChanged } = useValues(frameLogic)
  const { templates } = useValues(templatesModel)
  const { showingModal } = useValues(templatesLogic({ id }))
  const { showModal, hideModal, submitNewTemplate } = useActions(templatesLogic({ id }))
  return (
    <>
      <div className="space-y-2 float-right">
        <Button size="small" onClick={showModal}>
          Save as template
        </Button>
        {showingModal ? (
          <Form logic={templatesLogic} props={{ id }} formKey="newTemplate">
            <Modal
              title={<>Save as template</>}
              onClose={hideModal}
              footer={
                <div className="flex items-center justify-end p-6 border-t border-solid border-blueGray-200 rounded-b">
                  <Button color="none" onClick={hideModal}>
                    Close
                  </Button>
                  <Button color="teal" onClick={submitNewTemplate}>
                    Save Changes
                  </Button>
                </div>
              }
            >
              <div className="relative p-6 flex-auto space-y-4">
                <Field name="name" label="Template name">
                  <TextInput placeholder="Template name" required />
                </Field>
                <Field name="description" label="Description">
                  <TextArea placeholder="Pretty pictures..." required />
                </Field>
                <Field name="image" label="Image">
                  <Image />
                </Field>
              </div>
            </Modal>
          </Form>
        ) : null}
      </div>
      <div className="space-y-8">
        <div className="space-y-2">
          <H6>Local templates</H6>
          {templates.map((template) => (
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

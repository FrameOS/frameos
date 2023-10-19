import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { templatesLogic } from './templatesLogic'
import { Button } from '../../../../components/Button'
import { Form } from 'kea-forms'
import { Modal } from '../../../../components/Modal'
import { Field } from '../../../../components/Field'
import { TextInput } from '../../../../components/TextInput'
import { TextArea } from '../../../../components/TextArea'
import { Image } from '../Image/Image'

export function EditTemplate() {
  const { id } = useValues(frameLogic)
  const { showingModal, templateForm } = useValues(templatesLogic({ id }))
  const { hideModal, submitTemplateForm } = useActions(templatesLogic({ id }))
  const newTemplate = !templateForm.id
  return (
    <>
      {showingModal ? (
        <Form logic={templatesLogic} props={{ id }} formKey="templateForm">
          <Modal
            title={newTemplate ? <>Save as new template</> : <>Edit template</>}
            onClose={hideModal}
            open={showingModal}
            footer={
              <div className="flex items-top justify-end gap-2 p-6 border-t border-solid border-blueGray-200 rounded-b">
                <Button color="none" onClick={hideModal}>
                  Close
                </Button>
                <Button color="teal" onClick={submitTemplateForm}>
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
              {newTemplate ? (
                <Field name="image" label="Image">
                  <Image />
                </Field>
              ) : null}
            </div>
          </Modal>
        </Form>
      ) : null}
    </>
  )
}

import { useActions, useValues } from 'kea'
import { Form } from 'kea-forms'

import { Button } from '../Button'
import { Field } from '../Field'
import { Modal } from '../Modal'
import { Spinner } from '../Spinner'
import { Switch } from '../Switch'
import { TextArea } from '../TextArea'
import { TextInput } from '../TextInput'
import { sshKeysLogic } from './sshKeysLogic'

// "Add SSH key": a name, the public key (pasted, or — on a self-hosted
// backend — generated together with its private half), and whether new
// frames get it by default. Saves straight into the settings' key list.
export function AddSshKeyModal(): JSX.Element | null {
  const { addKeyModalOpen, generating, keepsPrivateKeys, isNewKeySubmitting } = useValues(sshKeysLogic)
  const { closeAddKeyModal, generateKeyPair } = useActions(sshKeysLogic)

  if (!addKeyModalOpen) {
    return null
  }

  return (
    <Modal open onClose={closeAddKeyModal} title="Add SSH key" panelClassName="max-w-[640px]">
      <Form logic={sshKeysLogic} formKey="newKey" props={{}} enableFormOnSubmit className="space-y-4 p-5">
        <Field name="name" label="Key name">
          <TextInput autoFocus placeholder="e.g. Marius' laptop" />
        </Field>
        <Field
          name="public"
          label="Public key"
          tooltip="The contents of your ~/.ssh/id_ed25519.pub (or id_rsa.pub). Only the public half is stored here."
        >
          <TextArea rows={3} placeholder="ssh-ed25519 AAAA… you@laptop" />
        </Field>
        {keepsPrivateKeys ? (
          <Field
            name="private"
            label="Private key (optional)"
            tooltip="Lets this backend ssh into frames with the key. Leave empty if you only ever ssh from your own computer."
          >
            <TextArea rows={3} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
          </Field>
        ) : null}
        <Field name="use_for_new_frames" label="Install on new frames by default">
          <Switch fullWidth />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            {keepsPrivateKeys ? (
              <Button
                type="button"
                size="small"
                color="secondary"
                onClick={generateKeyPair}
                disabled={generating}
                className="inline-flex items-center gap-1"
              >
                {generating ? <Spinner className="text-white" color="white" /> : null}
                Generate a key pair
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="button" size="small" color="secondary" onClick={closeAddKeyModal}>
              Cancel
            </Button>
            <Button type="submit" size="small" color="primary" disabled={isNewKeySubmitting}>
              Add key
            </Button>
          </div>
        </div>
      </Form>
    </Modal>
  )
}

import type { FormEvent } from 'react'
import { useActions, useValues } from 'kea'
import { Button } from '../../../../../components/Button'
import { Field } from '../../../../../components/Field'
import { Modal } from '../../../../../components/Modal'
import { Spinner } from '../../../../../components/Spinner'
import { Switch } from '../../../../../components/Switch'
import { TextInput } from '../../../../../components/TextInput'
import { Tooltip } from '../../../../../components/Tooltip'
import type { FrameId } from '../../../../../types'
import { frameLogic } from '../../../frameLogic'
import { LAN_ACCESS_HELP, LAN_ACCESS_SETTINGS_ANCHOR } from '../lanAccess'
import { LAN_ACCESS_CODE_LENGTH, lanAccessLogic } from '../lanAccessLogic'
import { SectionBody, SectionHeading } from './FrameSettingsSection'

/**
 * The frame's LAN access switch. It sits in the frame form for its place next
 * to Network but binds no field: the device changes the value, a code on its
 * panel to turn it on (lanAccessLogic).
 */
export function LanAccessSection(): JSX.Element {
  const { frameId } = useValues(frameLogic)
  const { lanAccess, disabling, disableError, pendingNote } = useValues(lanAccessLogic({ frameId }))
  const { switchChanged } = useActions(lanAccessLogic({ frameId }))
  const unknown = lanAccess === null

  return (
    // A fragment like every section: the panel's CSS styles `form > h6 + div`.
    <>
      <SectionHeading id={LAN_ACCESS_SETTINGS_ANCHOR}>
        <span className="inline-flex items-center gap-1.5">
          LAN access
          <Tooltip label="LAN access help" titleClassName="w-72" title={LAN_ACCESS_HELP} />
        </span>
      </SectionHeading>
      <SectionBody>
        <Field name="_noop" label="Let scenes reach the local network">
          <div className="w-full space-y-1">
            <div className="flex items-center gap-2">
              <Switch
                value={lanAccess === true}
                onChange={switchChanged}
                disabled={unknown || disabling}
                label={unknown ? 'Unknown' : lanAccess ? 'On' : 'Off'}
              />
              {disabling ? <Spinner /> : null}
            </div>
            {unknown ? (
              <div className="frameos-muted text-xs" data-testid="lan-access-unknown">
                This frame does not report LAN access yet. Update its FrameOS first.
              </div>
            ) : null}
            {pendingNote ? <div className="frameos-muted text-xs">{pendingNote}</div> : null}
            {disableError ? <div className="text-xs text-red-400">{disableError}</div> : null}
          </div>
        </Field>
      </SectionBody>
      <LanAccessModal frameId={frameId} />
    </>
  )
}

function LanAccessModal({ frameId }: { frameId: FrameId }): JSX.Element | null {
  const { phase, code, error, canConfirm, canRequestCode } = useValues(lanAccessLogic({ frameId }))
  const { closeModal, showCode, setCode, confirmCode } = useActions(lanAccessLogic({ frameId }))

  if (phase === 'closed') {
    return null
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    // The panel's frame form is a React ancestor even through the portal.
    event.stopPropagation()
    confirmCode()
  }

  const finished = phase === 'done' || phase === 'applyQueued'
  const codeAsked = phase === 'shown' || phase === 'queued' || phase === 'confirming'

  return (
    <Modal open onClose={closeModal} title="Turn on LAN access" panelClassName="max-w-[480px]">
      <form onSubmit={handleSubmit} className="space-y-4 p-5" data-testid="lan-access-modal">
        {finished ? (
          <p className="text-sm">
            {phase === 'done'
              ? 'LAN access is on.'
              : 'The frame checks the code when it wakes up. LAN access turns on if it matches.'}
          </p>
        ) : codeAsked ? (
          <>
            <p className="text-sm">
              {phase === 'queued'
                ? 'The frame will show the code when it wakes up.'
                : 'Enter the code showing on your frame.'}
            </p>
            <label className="block max-w-xs space-y-1 text-sm">
              <span className="frameos-form-label font-medium">Code</span>
              <TextInput
                autoFocus
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={LAN_ACCESS_CODE_LENGTH}
                placeholder="123456"
                value={code}
                onChange={setCode}
                aria-label="Code from the frame"
              />
            </label>
          </>
        ) : (
          <p className="text-sm">The frame shows a code on its screen. Type it here to turn LAN access on.</p>
        )}
        {error ? (
          <div className="text-sm text-red-400" role="alert">
            {error.message}
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          {finished ? (
            <Button type="button" size="small" color="primary" onClick={closeModal}>
              Done
            </Button>
          ) : (
            <>
              <Button type="button" size="small" color="secondary" onClick={closeModal}>
                Cancel
              </Button>
              {codeAsked ? (
                <>
                  <Button type="button" size="small" color="secondary" disabled={!canRequestCode} onClick={showCode}>
                    Show a new code
                  </Button>
                  <Button type="submit" size="small" color="primary" disabled={!canConfirm}>
                    {phase === 'confirming' ? <Spinner color="white" /> : null}
                    Turn on
                  </Button>
                </>
              ) : (
                <Button type="button" size="small" color="primary" disabled={!canRequestCode} onClick={showCode}>
                  {phase === 'requesting' ? <Spinner color="white" /> : null}
                  Show code on the frame
                </Button>
              )}
            </>
          )}
        </div>
      </form>
    </Modal>
  )
}

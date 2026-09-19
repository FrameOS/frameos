import { useActions, useValues } from 'kea'
import { useEffect, useRef } from 'react'

import { confirmDialogLogic } from '../utils/confirmDialogLogic'
import clsx from 'clsx'

import { buttonColor, buttonSize } from './Button'
import { Modal } from './Modal'
import { Spinner } from './Spinner'

/**
 * The app's one confirmation dialog — mounted once by each App root, fed by
 * `confirmDialog()` (utils/confirmDialogLogic). Replaces the blocking
 * `window.confirm` on delete/reset/disconnect flows.
 */
export function ConfirmDialog(): JSX.Element | null {
  const { pending, busy } = useValues(confirmDialogLogic)
  const { answer, confirm, hostMounted, hostUnmounted } = useActions(confirmDialogLogic)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    hostMounted()
    return () => hostUnmounted()
  }, [hostMounted, hostUnmounted])

  if (!pending) {
    return null
  }

  const paragraphs = pending.message.split(/\n\s*\n/).map((paragraph) => paragraph.trim())
  // While the confirmed work runs the dialog is the progress indicator: it
  // cannot be dismissed, and closes by itself when the work settles.
  const cancel = (): void => {
    if (!busy) {
      answer(false)
    }
  }

  return (
    <Modal
      title={pending.title ?? 'Are you sure?'}
      onClose={cancel}
      initialFocus={pending.danger ? cancelRef : confirmRef}
      panelClassName="max-w-[520px]"
      footer={
        <div className="frameos-divider flex flex-wrap items-center justify-end gap-2 border-t p-4">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            className={clsx(buttonSize('normal'), buttonColor('secondary'), busy && 'opacity-30')}
            onClick={cancel}
          >
            {pending.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            type="button"
            disabled={busy}
            aria-busy={busy}
            className={clsx(
              buttonSize('normal'),
              buttonColor(pending.danger ? 'red' : 'primary'),
              'flex items-center gap-2',
              busy && 'cursor-progress'
            )}
            onClick={() => confirm()}
          >
            {busy ? <Spinner {...(pending.danger ? {} : { color: 'white' as const })} /> : null}
            <span>
              {busy ? pending.busyLabel ?? pending.confirmLabel ?? 'Confirm' : pending.confirmLabel ?? 'Confirm'}
            </span>
          </button>
        </div>
      }
    >
      <div className="space-y-3 p-5">
        {paragraphs.map((paragraph, index) => (
          <p
            key={index}
            className={clsx('text-sm whitespace-pre-line', index === 0 ? 'frameos-strong' : 'frameos-muted')}
          >
            {paragraph}
          </p>
        ))}
      </div>
    </Modal>
  )
}

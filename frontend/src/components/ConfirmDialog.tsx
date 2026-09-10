import { useActions, useValues } from 'kea'
import { useEffect, useRef } from 'react'

import { confirmDialogLogic } from '../utils/confirmDialogLogic'
import clsx from 'clsx'

import { buttonColor, buttonSize } from './Button'
import { Modal } from './Modal'

/**
 * The app's one confirmation dialog — mounted once by each App root, fed by
 * `confirmDialog()` (utils/confirmDialogLogic). Replaces the blocking
 * `window.confirm` on delete/reset/disconnect flows.
 */
export function ConfirmDialog(): JSX.Element | null {
  const { pending } = useValues(confirmDialogLogic)
  const { answer, hostMounted, hostUnmounted } = useActions(confirmDialogLogic)
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

  return (
    <Modal
      title={pending.title ?? 'Are you sure?'}
      onClose={() => answer(false)}
      initialFocus={pending.danger ? cancelRef : confirmRef}
      panelClassName="max-w-[520px]"
      footer={
        <div className="flex flex-wrap justify-end gap-2 px-5 pb-5">
          <button
            ref={cancelRef}
            type="button"
            className={clsx(buttonSize('small'), buttonColor('secondary'))}
            onClick={() => answer(false)}
          >
            {pending.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={clsx(buttonSize('small'), buttonColor(pending.danger ? 'red' : 'primary'))}
            onClick={() => answer(true)}
          >
            {pending.confirmLabel ?? 'Confirm'}
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

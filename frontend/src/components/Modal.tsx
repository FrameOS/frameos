import type { ReactElement } from 'react'
import { Dialog } from '@headlessui/react'
import clsx from 'clsx'

export interface ModalProps {
  children: ReactElement[] | ReactElement
  title?: ReactElement | string
  footer?: ReactElement | string
  open?: boolean
  onClose: () => void
  initialFocus?: React.RefObject<HTMLElement | null>
  /** Overrides the panel's default max-w-[767px], e.g. 'max-w-[1000px]'. */
  panelClassName?: string
  /** Overrides the body's default max-h-[70vh], e.g. 'h-[calc(100dvh-9rem)]'. */
  bodyClassName?: string
  /**
   * 'center' (default) keeps the dialog vertically centered, which recenters
   * it whenever its content grows or shrinks. 'top' pins it near the top of
   * the viewport so a dialog with changing content doesn't jump around.
   */
  align?: 'center' | 'top'
}

export function Modal({
  open,
  children,
  title,
  footer,
  onClose,
  initialFocus,
  panelClassName,
  bodyClassName,
  align,
}: ModalProps): ReactElement {
  const isOpen = open === undefined || open
  return (
    <Dialog open={isOpen} onClose={onClose} {...(initialFocus ? { initialFocus } : {})} className="relative z-[120]">
      <div className="fixed inset-0 z-[120] bg-slate-950/35 backdrop-blur-sm" />
      <div
        className={clsx(
          'justify-center flex overflow-x-hidden overflow-y-auto fixed inset-0 z-[130] outline-none focus:outline-none',
          align === 'top' ? 'items-start pt-[8vh]' : 'items-center'
        )}
      >
        <Dialog.Panel className={clsx('relative w-auto my-6 mx-auto w-full', panelClassName ?? 'max-w-[767px]')}>
          <div className="frameos-panel border border-white/80 rounded-[24px] shadow-2xl relative flex flex-col bg-white/95 outline-none focus:outline-none backdrop-blur-xl">
            <>
              {title ? (
                <div className="frameos-divider flex items-start justify-between p-5 border-b border-solid rounded-t-[24px]">
                  <Dialog.Title className="frameos-strong text-3xl font-semibold">{title}</Dialog.Title>
                  {onClose ? (
                    <button
                      className="frameos-icon-button ml-auto flex h-9 w-9 items-center justify-center rounded-xl border-0 text-3xl leading-none font-semibold outline-none transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                      onClick={onClose}
                    >
                      <span className="block h-6 w-6 text-2xl leading-5 outline-none focus:outline-none">×</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div className={clsx('overflow-y-auto', bodyClassName ?? 'max-h-[70vh]')}>{children}</div>
              {footer}
            </>
          </div>
        </Dialog.Panel>
      </div>
    </Dialog>
  )
}

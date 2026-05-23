import { Dialog } from '@headlessui/react'

export interface ModalProps {
  children: JSX.Element[] | JSX.Element
  title?: JSX.Element | string
  footer?: JSX.Element | string
  open?: boolean
  onClose: () => void
}

export function Modal({ open, children, title, footer, onClose }: ModalProps): JSX.Element {
  const isOpen = open === undefined || open
  return (
    <Dialog open={isOpen} onClose={onClose} className="relative z-50">
      <div className="justify-center items-center flex overflow-x-hidden overflow-y-auto fixed inset-0 z-50 outline-none focus:outline-none">
        <Dialog.Panel className="relative w-auto my-6 mx-auto max-w-[767px] w-full">
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
                      <span className="block h-6 w-6 text-2xl leading-5 outline-none focus:outline-none">
                        ×
                      </span>
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div className="overflow-y-scroll max-h-[70vh]">{children}</div>
              {footer}
            </>
          </div>
        </Dialog.Panel>
      </div>
      <div className="fixed inset-0 z-40 bg-slate-950/35 backdrop-blur-sm" />
    </Dialog>
  )
}

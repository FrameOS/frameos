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
  console.log({ open, isOpen })
  return (
    <Dialog open={isOpen} onClose={onClose} className="relative z-50">
      <div className="justify-center items-center flex overflow-x-hidden overflow-y-auto fixed inset-0 z-50 outline-none focus:outline-none">
        <Dialog.Panel className="relative w-auto my-6 mx-auto max-w-[767px] w-full">
          <div className="border-0 rounded-lg shadow-lg relative flex flex-col bg-gray-700 outline-none focus:outline-none">
            <>
              {title ? (
                <div className="flex items-start justify-between p-5 border-b border-solid border-blueGray-200 rounded-t">
                  <Dialog.Title className="text-3xl font-semibold">{title}</Dialog.Title>
                  {onClose ? (
                    <button
                      className="p-1 ml-auto bg-transparent border-0 text-white float-right text-3xl leading-none font-semibold outline-none focus:outline-none"
                      onClick={onClose}
                    >
                      <span className="bg-transparent white h-6 w-6 text-2xl block outline-none focus:outline-none">
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
      <div className="opacity-25 fixed inset-0 z-40 bg-black" />
    </Dialog>
  )
}

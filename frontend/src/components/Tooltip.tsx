import { Popover, Transition } from '@headlessui/react'
import { InformationCircleIcon } from '@heroicons/react/24/solid'
import ReactDOM from 'react-dom'
import React, { useState } from 'react'
import { usePopper } from 'react-popper'
import clsx from 'clsx'

export interface TooltipProps {
  title: JSX.Element | string
  children?: React.ReactNode
  className?: string
}

export function Tooltip({ children, title, className }: TooltipProps) {
  const [referenceElement, setReferenceElement] = useState<HTMLButtonElement | null>(null)
  const [popperElement, setPopperElement] = useState<HTMLDivElement | null>(null)
  const { styles, attributes } = usePopper(referenceElement, popperElement, { strategy: 'fixed' })

  return (
    <Popover>
      {({ open, close }) => (
        <>
          <Popover.Button
            ref={setReferenceElement}
            className={clsx(
              'block justify-center text-sm font-medium text-white rounded-md focus:outline-none shadow-sm',
              className
            )}
          >
            {children ?? <InformationCircleIcon className="w-5 h-5" aria-label="Popover" />}
          </Popover.Button>
          {ReactDOM.createPortal(
            <Transition
              show={open}
              enter="transition ease-out duration-100"
              enterFrom="transform opacity-0 scale-95"
              enterTo="transform opacity-100 scale-100"
              leave="transition ease-in duration-75"
              leaveFrom="transform opacity-100 scale-100"
              leaveTo="transform opacity-0 scale-95"
            >
              <Popover.Panel
                static
                className="absolute right-0 w-56 mt-2 origin-top-right bg-gray-600 divide-y divide-gray-100 rounded-md shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none"
                ref={setPopperElement}
                style={styles.popper}
                {...attributes.popper}
              >
                <div className="py-1">
                  <div className="px-4 py-2 text-sm text-gray-100">{title}</div>
                </div>
              </Popover.Panel>
            </Transition>,
            document.querySelector('#popper')!
          )}
        </>
      )}
    </Popover>
  )
}

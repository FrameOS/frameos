import { Menu, Transition } from '@headlessui/react'
import { EllipsisHorizontalIcon, EllipsisVerticalIcon } from '@heroicons/react/24/solid'
import ReactDOM from 'react-dom'
import React, { useState } from 'react'
import { usePopper } from 'react-popper'
import clsx from 'clsx'
import { ButtonProps, buttonColor } from './Button'

export interface DropdownMenuItem {
  label: string
  icon?: React.ReactNode
  confirm?: string
  title?: string
  onClick?: () => void
}

export interface DropdownMenuProps {
  items: DropdownMenuItem[]
  className?: string
  buttonColor?: ButtonProps['color']
  horizontal?: boolean
}

export function DropdownMenu({ items, className, horizontal, buttonColor: _buttonColor }: DropdownMenuProps) {
  const [referenceElement, setReferenceElement] = useState<HTMLButtonElement | null>(null)
  const [popperElement, setPopperElement] = useState<HTMLDivElement | null>(null)
  const { styles, attributes } = usePopper(referenceElement, popperElement, { strategy: 'fixed' })

  return (
    <Menu>
      {({ open, close }) => (
        <>
          <Menu.Button
            ref={setReferenceElement}
            onClick={(e) => e.stopPropagation()}
            className={clsx(
              buttonColor(_buttonColor),
              'inline-flex justify-center px-1 py-1 text-sm font-medium text-white rounded-md focus:outline-none shadow-sm',
              className
            )}
          >
            {horizontal ? (
              <EllipsisHorizontalIcon className="w-5 h-5" aria-label="Menu" />
            ) : (
              <EllipsisVerticalIcon className="w-5 h-5" aria-label="Menu" />
            )}
          </Menu.Button>
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
              <Menu.Items
                static
                className="absolute right-0 w-56 mt-2 origin-top-right bg-gray-600 divide-y divide-gray-100 rounded-md shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none"
                ref={setPopperElement}
                style={styles.popper}
                {...attributes.popper}
              >
                <div className="py-1">
                  {items.map((item, index) => (
                    <Menu.Item key={index}>
                      {({ active }) => (
                        <a
                          href="#"
                          className={clsx(
                            `${
                              active && !!item.onClick ? 'bg-[#4a4b8c] text-white' : 'text-white'
                            } px-4 py-2 text-sm flex gap-2`
                          )}
                          title={item.title}
                          onClick={
                            item.onClick
                              ? (e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  if (item.confirm) {
                                    if (confirm(item.confirm)) {
                                      item.onClick?.()
                                    }
                                  } else {
                                    item.onClick?.()
                                  }
                                  close()
                                }
                              : undefined
                          }
                        >
                          {item.icon}
                          {item.label}
                        </a>
                      )}
                    </Menu.Item>
                  ))}
                </div>
              </Menu.Items>
            </Transition>,
            document.querySelector('#popper')!
          )}
        </>
      )}
    </Menu>
  )
}

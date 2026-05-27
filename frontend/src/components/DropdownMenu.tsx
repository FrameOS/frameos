import { Menu, Transition } from '@headlessui/react'
import { EllipsisHorizontalIcon, EllipsisVerticalIcon } from '@heroicons/react/24/solid'
import ReactDOM from 'react-dom'
import React, { useState } from 'react'
import { usePopper } from 'react-popper'
import clsx from 'clsx'
import { ButtonProps, buttonColor } from './Button'
import { Spinner } from './Spinner'

export interface DropdownMenuItem {
  label?: React.ReactNode
  content?: (close: () => void) => React.ReactNode
  icon?: React.ReactNode
  confirm?: string
  title?: string
  keepOpen?: boolean
  onClick?: (e: React.MouseEvent) => void
  loading?: boolean
  disabled?: boolean
}

export interface DropdownMenuProps {
  items: DropdownMenuItem[]
  className?: string
  buttonColor?: ButtonProps['color']
  horizontal?: boolean
}

export function DropdownMenu({ items, className, horizontal = true, buttonColor: _buttonColor }: DropdownMenuProps) {
  const [referenceElement, setReferenceElement] = useState<HTMLButtonElement | null>(null)
  const [popperElement, setPopperElement] = useState<HTMLDivElement | null>(null)
  const { styles, attributes } = usePopper(referenceElement, popperElement, {
    strategy: 'fixed',
    placement: 'bottom-end',
    modifiers: [
      {
        name: 'offset',
        options: {
          offset: [0, 4],
        },
      },
      {
        name: 'flip',
        options: {
          fallbackPlacements: ['top-end', 'bottom-start', 'top-start'],
        },
      },
      {
        name: 'preventOverflow',
        options: {
          padding: 8,
        },
      },
    ],
  })
  const isLoading = items.some((item) => item.loading)

  return (
    <Menu>
      {({ open, close }) => (
        <>
          <Menu.Button
            ref={setReferenceElement}
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className={clsx(
              buttonColor(_buttonColor),
              'inline-flex justify-center px-1 py-1 text-sm font-medium rounded-md focus:outline-none shadow-sm',
              className
            )}
          >
            {isLoading ? (
              <Spinner color="white" className="w-5 h-5" />
            ) : horizontal ? (
              <EllipsisHorizontalIcon className="w-5 h-5" aria-label="Menu" />
            ) : (
              <EllipsisVerticalIcon className="w-5 h-5" aria-label="Menu" />
            )}
          </Menu.Button>
          {ReactDOM.createPortal(
            <Transition
              show={open}
              enter="transition ease-out duration-100"
              enterFrom="opacity-0"
              enterTo="opacity-100"
              leave="transition ease-in duration-75"
              leaveFrom="opacity-100"
              leaveTo="opacity-0"
            >
              <Menu.Items
                static
                className="frameos-dropdown-menu z-[100] w-56 origin-top-right divide-y divide-slate-200/60 rounded-md focus:outline-none"
                ref={setPopperElement}
                style={styles.popper}
                {...attributes.popper}
              >
                <div className="py-1">
                  {items.map((item, index) => (
                    <Menu.Item key={index}>
                      {({ active }) => (
                        item.content ? (
                          <div
                            className={clsx(
                              'frameos-dropdown-item',
                              active && 'frameos-dropdown-item-active',
                              'px-4 py-2 text-sm'
                            )}
                            title={item.title}
                          >
                            {item.content(close)}
                          </div>
                        ) : (
                          <a
                            href="#"
                            className={clsx(
                              'frameos-dropdown-item px-4 py-2 text-sm flex gap-2',
                              active && !!item.onClick && !item.disabled && 'frameos-dropdown-item-active',
                              item.disabled && 'cursor-not-allowed opacity-50'
                            )}
                            title={item.title}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={
                              item.onClick || item.disabled
                                ? (e) => {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    if (item.disabled) {
                                      return
                                    }
                                    if (item.confirm) {
                                      if (confirm(item.confirm)) {
                                        item.onClick?.(e)
                                      }
                                    } else {
                                      item.onClick?.(e)
                                    }
                                    if (!item.keepOpen) {
                                      close()
                                    }
                                  }
                                : undefined
                            }
                          >
                            {item.loading ? <Spinner color="white" className="w-4 h-4" /> : item.icon}
                            {item.label}
                          </a>
                        )
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

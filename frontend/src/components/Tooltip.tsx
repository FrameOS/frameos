import { Popover, Transition } from '@headlessui/react'
import { InformationCircleIcon } from '@heroicons/react/24/solid'
import ReactDOM from 'react-dom'
import React, { useState } from 'react'
import { usePopper } from 'react-popper'
import clsx from 'clsx'
import { ButtonProps } from './Button'

export interface TooltipProps {
  title: JSX.Element | string
  titleClassName?: string
  children?: React.ReactNode
  className?: string
  containerClassName?: string
  tooltipColor?: ButtonProps['color']
  noPadding?: boolean
}

export function Tooltip({
  children,
  title,
  titleClassName,
  className,
  containerClassName,
  tooltipColor,
  noPadding,
}: TooltipProps) {
  const [referenceElement, setReferenceElement] = useState<HTMLButtonElement | null>(null)
  const [popperElement, setPopperElement] = useState<HTMLDivElement | null>(null)
  const { styles, attributes } = usePopper(referenceElement, popperElement, {
    strategy: 'fixed',
    placement: 'bottom-end',
    modifiers: [
      { name: 'offset', options: { offset: [0, 8] } },
      { name: 'flip', options: { padding: 8 } },
      // altAxis keeps tall panels (e.g. large JSON output examples) inside the viewport
      { name: 'preventOverflow', options: { padding: 8, altAxis: true, tether: false } },
      // adaptive right/bottom anchoring miscomputes against the #popper portal; always anchor top-left
      { name: 'computeStyles', options: { adaptive: false } },
    ],
  })

  return (
    <Popover className={containerClassName}>
      {({ open, close }) => (
        <>
          <Popover.Button
            ref={setReferenceElement}
            className={clsx(
              'frameos-tooltip-button block justify-center rounded-md text-sm font-medium shadow-sm focus:outline-none',
              className
            )}
          >
            {children ?? <InformationCircleIcon className="w-5 h-5" aria-label="Popover" />}
          </Popover.Button>
          {ReactDOM.createPortal(
            // opacity only: a transform on this wrapper would become the containing
            // block for the fixed-positioned panel and break popper's coordinates
            <Transition
              show={open}
              enter="transition ease-out duration-100"
              enterFrom="opacity-0"
              enterTo="opacity-100"
              leave="transition ease-in duration-75"
              leaveFrom="opacity-100"
              leaveTo="opacity-0"
            >
              <Popover.Panel
                static
                className={clsx(
                  'frameos-tooltip-panel origin-top-right rounded-md focus:outline-none',
                  noPadding ? '' : 'w-56',
                  titleClassName ? titleClassName : ''
                )}
                ref={setPopperElement}
                style={styles.popper}
                data-tooltip-color={tooltipColor || 'light-gray'}
                {...attributes.popper}
              >
                <div className={noPadding ? '' : 'py-1'}>
                  <div className={noPadding ? 'text-sm' : 'px-4 py-2 text-sm'}>{title}</div>
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

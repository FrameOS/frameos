import { Menu } from '@headlessui/react'
import ReactDOM from 'react-dom'
import { useEffect, useState } from 'react'
import { usePopper } from 'react-popper'
import { useActions, useValues } from 'kea'
import { diagramLogic } from './diagramLogic'
import clsx from 'clsx'
import { TextInput } from '../../../../components/TextInput'
import { newNodePickerLogic } from './newNodePickerLogic'

export function NewNodePicker() {
  const { sceneId, frameId } = useValues(diagramLogic)
  const { closeNewNodePicker, selectNewNodeOption, setSearchValue } = useActions(
    newNodePickerLogic({ sceneId, frameId })
  )
  const { searchPlaceholder, placement, newNodePicker, newNodeOptions, newNodePickerIndex, searchValue } = useValues(
    newNodePickerLogic({ sceneId, frameId })
  )
  const [referenceElement, setReferenceElement] = useState<HTMLButtonElement | null>(null)
  const [searchElement, setSearchElement] = useState<HTMLInputElement | null>(null)
  const [popperElement, setPopperElement] = useState<HTMLDivElement | null>(null)
  const { styles, attributes } = usePopper(referenceElement, popperElement, {
    strategy: 'fixed',
    placement: placement as any,
  })

  useEffect(() => {
    if (!referenceElement) return
    referenceElement.click()
  }, [referenceElement])

  useEffect(() => {
    if (!searchElement) return
    searchElement.focus()
  }, [searchElement])

  const x = newNodePicker?.screenX ?? 0
  const y = newNodePicker?.screenY ?? 0

  return (
    <Menu key={newNodePickerIndex}>
      {({ open, close }) => (
        <>
          <Menu.Button
            ref={setReferenceElement}
            style={{
              position: 'fixed',
              top: y - 60,
              left: x - 5,
            }}
          />
          {ReactDOM.createPortal(
            <div>
              {open ? (
                <Menu.Items
                  static
                  className="absolute right-0 w-56 mt-2 origin-top-right bg-gray-600 divide-y divide-gray-100 rounded-md shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none"
                  ref={setPopperElement}
                  style={styles.popper}
                  {...attributes.popper}
                >
                  <div>
                    <TextInput
                      placeholder={searchPlaceholder}
                      className="w-full"
                      ref={setSearchElement}
                      value={searchValue}
                      onChange={setSearchValue}
                      onKeyDown={(e) => {
                        const activeOptions = popperElement?.querySelectorAll('[data-active-menu-selection]')
                        if (activeOptions && activeOptions.length > 0) {
                          return // The button click will handle the selection
                        }
                        if (e.key === 'Enter' && Object.keys(newNodeOptions).length >= 1) {
                          e.preventDefault()
                          close()
                          closeNewNodePicker()
                          if (newNodePicker) {
                            selectNewNodeOption(
                              newNodePicker,
                              newNodeOptions[0].value,
                              newNodeOptions[0].label,
                              newNodeOptions[0].type ?? 'string'
                            )
                          }
                        }
                      }}
                    />
                  </div>
                  <div className="py-1" style={{ maxHeight: 200, overflowX: 'auto', overflowY: 'auto' }}>
                    {newNodeOptions.map(({ label, value }) => (
                      <Menu.Item key={value || label}>
                        {({ active }) => (
                          <a
                            key={value || label}
                            href="#"
                            className={clsx(
                              active ? 'bg-[#4a4b8c] text-white' : 'text-white',
                              'px-4 py-1 text-sm flex gap-2'
                            )}
                            data-active-menu-selection={active ? true : undefined}
                            onClick={(e) => {
                              e.preventDefault()
                              close()
                              closeNewNodePicker()
                              if (newNodePicker) {
                                selectNewNodeOption(newNodePicker, value, label)
                              }
                            }}
                          >
                            {label}
                          </a>
                        )}
                      </Menu.Item>
                    ))}
                  </div>
                </Menu.Items>
              ) : null}
            </div>,
            document.querySelector('#popper')!
          )}
        </>
      )}
    </Menu>
  )
}

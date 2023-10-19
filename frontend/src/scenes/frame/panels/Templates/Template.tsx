import { TemplateType } from '../../../../types'
import { H6 } from '../../../../components/H6'
import { Button } from '../../../../components/Button'
import { Menu } from '@headlessui/react'

import React, { useState } from 'react'
import { Transition } from '@headlessui/react'
import {
  ArrowDownTrayIcon,
  DocumentArrowDownIcon,
  EllipsisVerticalIcon,
  PencilSquareIcon,
  TrashIcon,
} from '@heroicons/react/24/solid'
import { usePopper } from 'react-popper'
import ReactDOM from 'react-dom'

interface TemplateProps {
  template: TemplateType
  applyTemplate: (template: TemplateType) => void
  exportTemplate?: (id: string, format?: string) => void
  removeTemplate?: (id: string) => void
  editTemplate?: (template: TemplateType) => void
}
export function Template({ template, exportTemplate, removeTemplate, applyTemplate, editTemplate }: TemplateProps) {
  let [referenceElement, setReferenceElement] = useState<HTMLButtonElement | null>(null)
  let [popperElement, setPopperElement] = useState<HTMLDivElement | null>(null)
  let { styles, attributes } = usePopper(referenceElement, popperElement, { strategy: 'fixed' })

  return (
    <div
      className="shadow bg-gray-900 break-inside-avoid dndnode relative rounded-lg"
      style={
        template.image_width && template.image_height
          ? {
              backgroundImage: `url("${template.image}")`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              // aspectRatio: `${template.image_width} / ${template.image_height}`,
            }
          : {}
      }
    >
      <div
        className="w-full h-full p-3 space-y-2 rounded-lg border border-gray-700"
        style={{
          backgroundImage:
            'linear-gradient(to bottom, rgba(0, 0, 0, 0.8) 0%, rgba(0, 0, 0, 0.6) 30%, rgba(0, 0, 0, 0.7) 70%, rgba(0, 0, 0, 0.8) 100%)',
        }}
      >
        <div className="flex items-start justify-between">
          <H6>{template.name}</H6>
          <div className="flex items-start gap-1">
            {editTemplate || exportTemplate || removeTemplate ? (
              <div className="relative inline-block text-left">
                <Menu>
                  {({ open, close }) => (
                    <>
                      <Menu.Button
                        ref={setReferenceElement}
                        className="inline-flex justify-center w-full px-1 py-1 text-sm font-medium text-white bg-gray-700 hover:bg-gray-500 focus:ring-gray-500 rounded-md focus:outline-none rounded-md shadow-sm"
                      >
                        <EllipsisVerticalIcon className="w-5 h-5" aria-label="Menu" />
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
                              {editTemplate ? (
                                <Menu.Item>
                                  {({ active }) => (
                                    <a
                                      href="#"
                                      className={`${
                                        active ? 'bg-teal-700 text-white' : 'text-white'
                                      } block px-4 py-2 text-sm flex gap-2`}
                                      onClick={(e) => {
                                        e.preventDefault()
                                        editTemplate(template)
                                        close()
                                      }}
                                    >
                                      <PencilSquareIcon className="w-5 h-5" />
                                      Edit metadata
                                    </a>
                                  )}
                                </Menu.Item>
                              ) : null}
                              {exportTemplate ? (
                                <Menu.Item>
                                  {({ active }) => (
                                    <a
                                      href={`/api/templates/${template.id}/export`}
                                      className={`${
                                        active ? 'bg-teal-700 text-white' : 'text-white'
                                      } block px-4 py-2 text-sm flex gap-2`}
                                    >
                                      <DocumentArrowDownIcon className="w-5 h-5" />
                                      Download
                                    </a>
                                  )}
                                </Menu.Item>
                              ) : null}
                              {removeTemplate ? (
                                <Menu.Item>
                                  {({ active }) => (
                                    <a
                                      href="#"
                                      className={`${
                                        active ? 'bg-teal-700 text-white' : 'text-white'
                                      } block px-4 py-2 text-sm flex gap-2`}
                                      onClick={(e) => {
                                        e.preventDefault()
                                        if (
                                          template.id &&
                                          confirm(`Are you sure you want to delete the template "${template.name}"?`)
                                        ) {
                                          removeTemplate(template.id)
                                          close()
                                        }
                                      }}
                                    >
                                      <TrashIcon className="w-5 h-5" />
                                      Delete
                                    </a>
                                  )}
                                </Menu.Item>
                              ) : null}
                            </div>
                          </Menu.Items>
                        </Transition>,
                        document.querySelector('#popper')!
                      )}
                    </>
                  )}
                </Menu>
              </div>
            ) : null}
            <Button
              size="small"
              color="teal"
              className="flex gap-1 items-center"
              onClick={() => {
                if (
                  confirm(
                    template.id
                      ? `Replace the frame's contents with the template "${template.name}"? You will still need to save and deploy.`
                      : `This will add the template to your list of local templates, after which you can install it.`
                  )
                ) {
                  applyTemplate(template as TemplateType)
                }
              }}
            >
              <ArrowDownTrayIcon className="w-4 h-4" /> {template.id ? 'Install' : 'Download'}
            </Button>
          </div>
        </div>
        {template.description && <div className="text-white text-sm">{template.description}</div>}
      </div>
    </div>
  )
}

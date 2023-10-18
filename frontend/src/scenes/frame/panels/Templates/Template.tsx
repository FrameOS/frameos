import { TemplateType } from '../../../../types'
import { templatesModel } from '../../../../models/templatesModel'
import { frameLogic } from '../../frameLogic'
import { H6 } from '../../../../components/H6'
import { Button } from '../../../../components/Button'
import { Menu } from '@headlessui/react'

interface TemplateProps {
  template: TemplateType
  exportTemplate: typeof templatesModel.actions.exportTemplate
  removeTemplate: typeof templatesModel.actions.removeTemplate
  applyTemplate: typeof frameLogic.actions.applyTemplate
}
import React from 'react'
import { Transition } from '@headlessui/react'
import {
  ArrowDownTrayIcon,
  DocumentArrowDownIcon,
  EllipsisVerticalIcon,
  PencilSquareIcon,
  TrashIcon,
} from '@heroicons/react/24/solid'

export function Template({ template, exportTemplate, removeTemplate, applyTemplate }: TemplateProps) {
  return (
    <div
      className="shadow bg-gray-900 break-inside-avoid dndnode relative rounded-lg"
      style={
        template.image_width && template.image_height
          ? {
              backgroundImage: `url("/api/templates/${template.id}/image")`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              aspectRatio: `${template.image_width} / ${template.image_height}`,
            }
          : {}
      }
    >
      <div
        className="w-full h-full p-3 space-y-2 rounded-lg border border-gray-700"
        style={{
          backgroundImage:
            'linear-gradient(to bottom, rgba(0, 0, 0, 0.7) 0%, rgba(0, 0, 0, 0.5) 30%, rgba(0, 0, 0, 0.6) 70%, rgba(0, 0, 0, 0.7) 100%)',
        }}
      >
        <div className="flex items-start justify-between">
          <H6>{template.name}</H6>
          <div className="flex items-start gap-1">
            <div className="relative inline-block text-left">
              <Menu>
                {({ open, close }) => (
                  <>
                    <Menu.Button className="inline-flex justify-center w-full px-1 py-1 text-sm font-medium text-white bg-gray-700 hover:bg-gray-500 focus:ring-gray-500 rounded-md focus:outline-none rounded-md shadow-sm">
                      <EllipsisVerticalIcon className="w-5 h-5" aria-label="Menu" />
                    </Menu.Button>
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
                      >
                        <div className="py-1">
                          <Menu.Item>
                            {({ active }) => (
                              <a
                                href="#"
                                className={`${
                                  active ? 'bg-teal-700 text-white' : 'text-white'
                                } block px-4 py-2 text-sm flex gap-2`}
                              >
                                <PencilSquareIcon className="w-5 h-5" />
                                Edit template
                              </a>
                            )}
                          </Menu.Item>
                          <Menu.Item>
                            {({ active }) => (
                              <a
                                href="#"
                                className={`${
                                  active ? 'bg-teal-700 text-white' : 'text-white'
                                } block px-4 py-2 text-sm flex gap-2`}
                                onClick={(e) => {
                                  e.preventDefault()
                                  template.id && exportTemplate(template.id)
                                  close()
                                }}
                              >
                                <DocumentArrowDownIcon className="w-5 h-5" />
                                Export as JSON
                              </a>
                            )}
                          </Menu.Item>
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
                        </div>
                      </Menu.Items>
                    </Transition>
                  </>
                )}
              </Menu>
            </div>
            <Button
              size="small"
              color="teal"
              className="flex gap-1 items-center"
              onClick={() => {
                if (confirm(`Are you sure you want to replace the scene with the "${template.name}" template?`)) {
                  applyTemplate(template as TemplateType)
                }
              }}
            >
              <ArrowDownTrayIcon className="w-4 h-4" /> Install
            </Button>
          </div>
        </div>
        {template.description && <div className="text-white text-sm">{template.description}</div>}
      </div>
    </div>
  )
}

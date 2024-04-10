import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { scenesLogic } from './scenesLogic'
import { Button } from '../../../../components/Button'
import { Box } from '../../../../components/Box'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { PencilSquareIcon, TrashIcon, FlagIcon, FolderOpenIcon } from '@heroicons/react/24/solid'
import { panelsLogic } from '../panelsLogic'
import { TextInput } from '../../../../components/TextInput'
import { Form } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { H6 } from '../../../../components/H6'
import { Tag } from '../../../../components/Tag'
import { Select } from '../../../../components/Select'
import {
  AdjustmentsHorizontalIcon,
  CloudArrowDownIcon,
  DocumentDuplicateIcon,
  DocumentMagnifyingGlassIcon,
  FolderArrowDownIcon,
  FolderPlusIcon,
  PlusIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline'
import { templatesLogic } from '../Templates/templatesLogic'
import { SceneSettings } from './SceneSettings'
import React from 'react'

export function Scenes() {
  const { frameId, frameForm } = useValues(frameLogic)
  const { editScene, editSceneJSON, openTemplates } = useActions(panelsLogic)
  const { scenes, showNewSceneForm, isNewSceneSubmitting, sceneTemplateOptions, showingSettings } = useValues(
    scenesLogic({ frameId })
  )
  const {
    toggleSettings,
    submitNewScene,
    renameScene,
    duplicateScene,
    deleteScene,
    setAsDefault,
    toggleNewScene,
    closeNewScene,
  } = useActions(scenesLogic({ frameId }))
  const { saveAsTemplate, saveAsZip } = useActions(templatesLogic({ frameId }))

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex justify-between w-full items-center">
          <H6>Installed scenes</H6>
          <DropdownMenu
            buttonColor="secondary"
            className="mr-3"
            items={[
              {
                label: 'Save as template',
                onClick: () => saveAsTemplate({ name: frameForm.name }),
                icon: <FolderArrowDownIcon className="w-5 h-5" />,
              },
              {
                label: 'Download as .zip',
                onClick: () => saveAsZip({ name: frameForm.name || 'Exported scenes' }),
                icon: <CloudArrowDownIcon className="w-5 h-5" />,
              },
            ]}
          />
        </div>
        {scenes.map((scene) => (
          <React.Fragment key={scene.id}>
            <Box className="p-2 pl-4 pr-3 space-y-2 bg-gray-900 flex items-start justify-between gap-1">
              <div>
                <H6>
                  <span className="cursor-pointer" onClick={() => editScene(scene.id)}>
                    {scene.name || scene.id}
                  </span>
                  {scene.default ? (
                    <Tag className="ml-2" color="primary">
                      default
                    </Tag>
                  ) : null}
                  {scene?.settings?.refreshInterval && Number.isFinite(scene.settings.refreshInterval) ? (
                    <Tag
                      className="ml-2 cursor-pointer"
                      color={scene.settings.refreshInterval > 1 ? 'secondary' : 'red'}
                      onClick={() => toggleSettings(scene.id)}
                    >
                      {scene.settings.refreshInterval > 1
                        ? `${scene.settings.refreshInterval}`
                        : `${Math.round((1 / scene.settings.refreshInterval) * 10) / 10} fps`}
                    </Tag>
                  ) : null}
                </H6>
                <div className="text-xs text-gray-400">id: {scene.id}</div>
              </div>
              <div className="flex gap-1">
                <Button size="small" className="!px-1" color="secondary" onClick={() => toggleSettings(scene.id)}>
                  <AdjustmentsHorizontalIcon className="w-5 h-5" />
                </Button>
                <DropdownMenu
                  buttonColor="secondary"
                  items={[
                    {
                      label: 'Edit scene',
                      onClick: () => editScene(scene.id),
                      icon: <FolderOpenIcon className="w-5 h-5" />,
                    },
                    {
                      label: 'Edit scene as JSON',
                      onClick: () => editSceneJSON(scene.id),
                      icon: <DocumentMagnifyingGlassIcon className="w-5 h-5" />,
                    },
                    {
                      label: 'Toggle settings',
                      onClick: () => toggleSettings(scene.id),
                      icon: <AdjustmentsHorizontalIcon className="w-5 h-5" />,
                    },
                    {
                      label: 'Save as template',
                      onClick: () => saveAsTemplate({ name: scene.name ?? '', exportScenes: [scene.id] }),
                      icon: <FolderPlusIcon className="w-5 h-5" />,
                    },
                    {
                      label: 'Download as .zip',
                      onClick: () => saveAsZip({ name: scene.name ?? '', exportScenes: [scene.id] }),
                      icon: <CloudArrowDownIcon className="w-5 h-5" />,
                    },
                    {
                      label: 'Duplicate',
                      onClick: () => duplicateScene(scene.id),
                      icon: <DocumentDuplicateIcon className="w-5 h-5" />,
                    },
                    {
                      label: 'Rename',
                      onClick: () => renameScene(scene.id),
                      icon: <PencilSquareIcon className="w-5 h-5" />,
                    },
                    ...(!scene.default
                      ? [
                          {
                            label: 'Set as default',
                            onClick: () => setAsDefault(scene.id),
                            icon: <FlagIcon className="w-5 h-5" />,
                          },
                        ]
                      : []),
                    ...(scenes.length > 1
                      ? [
                          {
                            label: 'Delete scene',
                            confirm: 'Are you sure you want to delete this scene?',
                            onClick: () => deleteScene(scene.id),
                            icon: <TrashIcon className="w-5 h-5" />,
                          },
                        ]
                      : []),
                  ]}
                />
              </div>
            </Box>
            {showingSettings[scene.id] ? (
              <Box className="p-2 pl-4 pr-3 space-y-2 bg-gray-900 flex items-start justify-between gap-1 ml-4">
                <SceneSettings sceneId={scene.id} onClose={() => toggleSettings(scene.id)} />
              </Box>
            ) : null}
          </React.Fragment>
        ))}
        {showNewSceneForm ? (
          <Form logic={scenesLogic} props={{ frameId }} formKey="newScene">
            <Box className="p-4 space-y-4 bg-gray-900">
              <H6>New scene</H6>
              <Field label="Name" name="name">
                <TextInput placeholder="e.g. Camera view" />
              </Field>
              <Field
                label="Template"
                name="template"
                hint='This list contains basic system templates. Use the "Templates" panel on the right to install fancier ones.'
              >
                <Select options={sceneTemplateOptions} />
              </Field>
              <div className="flex gap-2">
                <Button size="small" color="primary" onClick={submitNewScene} disabled={isNewSceneSubmitting}>
                  Add Scene
                </Button>
                <Button size="small" color="secondary" className="flex gap-1 items-center" onClick={closeNewScene}>
                  Close
                </Button>
              </div>
            </Box>
          </Form>
        ) : (
          <div className="flex gap-2">
            <Button size="small" color="secondary" className="flex gap-1 items-center" onClick={toggleNewScene}>
              <PlusIcon className="w-4 h-4" />
              Add new scene
            </Button>
            <Button size="small" color="secondary" className="flex gap-1 items-center" onClick={openTemplates}>
              <SparklesIcon className="w-4 h-4" />
              Explore templates
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

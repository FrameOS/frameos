import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { scenesLogic } from './scenesLogic'
import { Button } from '../../../../components/Button'
import { Box } from '../../../../components/Box'
import { DropdownMenu } from '../../../../components/DropdownMenu'
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
  FolderArrowDownIcon,
  PlusIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline'
import { templatesLogic } from '../Templates/templatesLogic'
import { SceneSettings } from './SceneSettings'
import React from 'react'
import { SceneDropDown } from './SceneDropDown'
import { showAsFps } from '../../../../decorators/refreshInterval'
import clsx from 'clsx'

export function Scenes() {
  const { frameId, frameForm } = useValues(frameLogic)
  const { editScene, openTemplates, openControl } = useActions(panelsLogic)
  const { scenes, showNewSceneForm, isNewSceneSubmitting, showingSettings, activeSceneId } = useValues(
    scenesLogic({ frameId })
  )
  const { toggleSettings, submitNewScene, toggleNewScene, createNewScene, closeNewScene } = useActions(
    scenesLogic({ frameId })
  )
  const { saveAsTemplate, saveAsZip } = useActions(templatesLogic({ frameId }))

  if (scenes.length === 0 && !showNewSceneForm) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center space-y-4 mb-8">
          <H6>No scenes installed yet</H6>
          <p className="text-gray-400">
            Scenes are the building blocks of your frame. They can be anything from a simple clock to a complex
            interactive thermostat.
          </p>
          <div className="flex justify-center">
            <Button size="small" color="secondary" className="flex gap-1 items-center" onClick={createNewScene}>
              <PlusIcon className="w-4 h-4" />
              New blank scene
            </Button>
          </div>
          <p className="text-gray-400">or</p>
          <div className="flex justify-center">
            <Button size="small" color="secondary" className="flex gap-1 items-center" onClick={openTemplates}>
              <SparklesIcon className="w-4 h-4" />
              Explore available scenes
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {scenes.length > 0 ? (
          <div className="flex justify-between w-full items-center">
            <H6>Installed on frame</H6>
            <DropdownMenu
              buttonColor="secondary"
              className="mr-3"
              items={[
                {
                  label: 'Save to "My scenes"',
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
        ) : null}
        {scenes.map((scene) => (
          <React.Fragment key={scene.id}>
            <div
              className={clsx(
                'border rounded-lg shadow bg-gray-900 break-inside-avoid',
                'p-2 pl-4 pr-3 space-y-2 flex items-start justify-between gap-1',
                activeSceneId === scene.id
                  ? 'border border-[#4a4b8c] shadow-[0_0_3px_3px_rgba(128,0,255,0.5)]'
                  : 'border-gray-700'
              )}
            >
              <div>
                <H6>
                  <span className="cursor-pointer" onClick={() => editScene(scene.id)}>
                    {scene.name || scene.id}
                  </span>
                  {scene.default ? (
                    <Tag className="ml-2" color="primary">
                      start on boot
                    </Tag>
                  ) : null}
                  {scene?.settings?.refreshInterval && Number.isFinite(scene.settings.refreshInterval) ? (
                    <Tag
                      className="ml-2 cursor-pointer"
                      color={scene.settings.refreshInterval > 1 ? 'secondary' : 'red'}
                      onClick={() => toggleSettings(scene.id)}
                    >
                      {showAsFps(scene.settings.refreshInterval)}
                    </Tag>
                  ) : null}
                  {activeSceneId === scene.id ? (
                    <Tag className="ml-2 cursor-pointer" color="primary" onClick={() => openControl()}>
                      active
                    </Tag>
                  ) : null}
                </H6>
                <div className="text-xs text-gray-400">id: {scene.id}</div>
              </div>
              <div className="flex gap-1">
                <Button
                  size="small"
                  className="!px-1"
                  color="secondary"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleSettings(scene.id)
                  }}
                >
                  <AdjustmentsHorizontalIcon className="w-5 h-5" />
                </Button>
                <SceneDropDown context="scenes" sceneId={scene.id} />
              </div>
            </div>
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
              Explore available scenes
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

Scenes.PanelTitle = function ScenesPanelTitle() {
  return <>Installed scenes</>
}

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
import { Templates } from './Templates'
import { PlusIcon } from '@heroicons/react/24/outline'
import { SaveAsTemplate } from './SaveAsTemplate'

export function Scenes() {
  const { frameId } = useValues(frameLogic)
  const { editScene } = useActions(panelsLogic)
  const { scenes, showNewSceneForm, isNewSceneSubmitting, newSceneHasErrors, sceneTemplateOptions } = useValues(
    scenesLogic({ frameId })
  )
  const { submitNewScene, renameScene, deleteScene, setAsDefault, addNewScene, closeNewScene } = useActions(
    scenesLogic({ frameId })
  )

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <H6>Scenes on this frame</H6>
        {scenes.map((scene) => (
          <Box key={scene.id} className="p-2 pl-4 space-y-2 bg-gray-900">
            <div className="flex items-start justify-between gap-1">
              <div>
                <H6 className="cursor-pointer" onClick={() => editScene(scene.id)}>
                  {scene.name || scene.id}
                  {scene.default ? (
                    <Tag className="ml-2" color="primary">
                      default
                    </Tag>
                  ) : null}
                </H6>
                <div className="text-xs text-gray-400">id: {scene.id}</div>
              </div>
              <div className="flex items-start gap-1">
                <DropdownMenu
                  buttonColor="secondary"
                  items={[
                    {
                      label: 'Open in editor',
                      onClick: () => editScene(scene.id),
                      icon: <FolderOpenIcon className="w-5 h-5" />,
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
            </div>
          </Box>
        ))}
      </div>
      {showNewSceneForm ? (
        <Form logic={scenesLogic} props={{ frameId }} formKey="newScene">
          <Box className="p-4 space-y-4 bg-gray-900">
            <H6>New scene</H6>
            <Field label="Name" name="name">
              <TextInput placeholder="e.g. Camera view" />
            </Field>
            <Field label="Template" name="template">
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
        <Button size="small" color="secondary" className="flex gap-1 items-center" onClick={addNewScene}>
          <PlusIcon className="w-4 h-4" />
          Add new scene
        </Button>
      )}
      <SaveAsTemplate />
      <Templates />
    </div>
  )
}

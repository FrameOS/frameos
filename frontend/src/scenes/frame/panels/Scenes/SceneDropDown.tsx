import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { scenesLogic } from './scenesLogic'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { PencilSquareIcon, TrashIcon, FlagIcon, PlayIcon } from '@heroicons/react/24/solid'
import { panelsLogic } from '../panelsLogic'
import {
  ClipboardDocumentIcon,
  CloudArrowDownIcon,
  DocumentDuplicateIcon,
  DocumentMagnifyingGlassIcon,
  EyeIcon,
  FolderPlusIcon,
  TagIcon,
  ArrowsPointingInIcon,
  ArrowsPointingOutIcon,
} from '@heroicons/react/24/outline'
import { templatesLogic } from '../Templates/templatesLogic'
import { controlLogic } from './controlLogic'
import { findConnectedScenes } from './utils'
import { Panel } from '../../../../types'

interface SceneDropDownProps {
  sceneId: string
  context: 'scenes' | 'editDiagram'
}

function isNotNull<T>(value: T | null): value is T {
  return value !== null
}

export function SceneDropDown({ sceneId, context }: SceneDropDownProps) {
  const { frameId } = useValues(frameLogic)
  const { editScene, editSceneJSON, toggleFullScreenPanel } = useActions(panelsLogic)
  const { fullScreenPanel } = useValues(panelsLogic)
  const { sceneId: currentSceneId } = useValues(controlLogic({ frameId }))
  const { scenes, undeployedSceneIds, unsavedSceneIds, previewingSceneId } = useValues(scenesLogic({ frameId }))
  const { renameScene, duplicateScene, deleteScene, setAsDefault, removeDefault, copySceneJSON, previewScene } =
    useActions(scenesLogic({ frameId }))
  const { saveAsTemplate, saveAsZip } = useActions(templatesLogic({ frameId }))
  const { setCurrentScene } = useActions(controlLogic({ frameId }))
  const isFullScreen = fullScreenPanel?.panel === Panel.Diagram && fullScreenPanel?.key === sceneId
  const scene = scenes.find((s) => s.id === sceneId)
  if (!scene) {
    return null
  }
  const sceneHasChanges = unsavedSceneIds.has(scene.id) || undeployedSceneIds.has(scene.id)
  const isPreviewing = previewingSceneId === scene.id
  return (
    <DropdownMenu
      buttonColor="secondary"
      items={[
        context === 'editDiagram'
          ? {
              label: isFullScreen ? 'Collapse panel' : 'Expand panel',
              onClick: () => toggleFullScreenPanel({ panel: Panel.Diagram, key: scene.id }),
              icon: isFullScreen ? (
                <ArrowsPointingInIcon className="w-5 h-5" />
              ) : (
                <ArrowsPointingOutIcon className="w-5 h-5" />
              ),
            }
          : null,
        {
          label: 'Activate',
          onClick: () => setCurrentScene(scene.id),
          icon: <PlayIcon className="w-5 h-5" />,
        },
        scene.id !== currentSceneId && sceneHasChanges
          ? {
              label: 'Preview',
              onClick: () => previewScene(scene.id),
              icon: <EyeIcon className="w-5 h-5" />,
              title: 'Preview unsaved changes on the frame',
              loading: isPreviewing,
            }
          : null,
        context === 'scenes'
          ? {
              label: 'Edit scene',
              onClick: () => editScene(scene.id),
              icon: <PencilSquareIcon className="w-5 h-5" />,
            }
          : null,
        {
          label: 'Edit scene JSON',
          onClick: () => editSceneJSON(scene.id),
          icon: <DocumentMagnifyingGlassIcon className="w-5 h-5" />,
        },
        {
          label: 'Copy scene JSON',
          onClick: () => copySceneJSON(scene.id),
          icon: <ClipboardDocumentIcon className="w-5 h-5" />,
        },
        {
          label: 'Save to "My scenes"',
          onClick: () =>
            saveAsTemplate({ name: scene.name ?? '', exportScenes: findConnectedScenes(scenes, scene.id) }),
          icon: <FolderPlusIcon className="w-5 h-5" />,
        },
        {
          label: 'Download as .zip',
          onClick: () => saveAsZip({ name: scene.name ?? '', exportScenes: findConnectedScenes(scenes, scene.id) }),
          icon: <CloudArrowDownIcon className="w-5 h-5" />,
        },
        context === 'scenes'
          ? {
              label: 'Duplicate',
              onClick: () => duplicateScene(scene.id),
              icon: <DocumentDuplicateIcon className="w-5 h-5" />,
            }
          : null,
        {
          label: 'Rename',
          onClick: () => renameScene(scene.id),
          icon: <TagIcon className="w-5 h-5" />,
        },

        scene.default
          ? {
              label: 'Remove "start on boot"',
              onClick: () => removeDefault(),
              icon: <FlagIcon className="w-5 h-5" />,
            }
          : {
              label: 'Set to start on boot',
              onClick: () => setAsDefault(scene.id),
              icon: <FlagIcon className="w-5 h-5" />,
            },
        {
          label: 'Delete scene',
          confirm: 'Are you sure you want to delete this scene?',
          onClick: () => deleteScene(scene.id),
          icon: <TrashIcon className="w-5 h-5" />,
        },
      ].filter(isNotNull)}
    />
  )
}

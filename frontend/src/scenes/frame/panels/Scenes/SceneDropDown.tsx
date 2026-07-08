import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { scenesLogic } from './scenesLogic'
import { DropdownMenu, DropdownMenuProps } from '../../../../components/DropdownMenu'
import { PencilSquareIcon, TrashIcon, FlagIcon, PlayIcon } from '@heroicons/react/24/solid'
import { frameEditorsLogic } from '../../frameEditorsLogic'
import {
  ArrowPathIcon,
  ClipboardDocumentIcon,
  CloudArrowDownIcon,
  Cog6ToothIcon,
  DocumentDuplicateIcon,
  DocumentMagnifyingGlassIcon,
  FolderPlusIcon,
  TagIcon,
} from '@heroicons/react/24/outline'
import { templatesLogic } from '../Templates/templatesLogic'
import { findConnectedScenes } from './utils'
import { openWorkspaceSceneUtility, workspaceLogic } from '../../../workspace/workspaceLogic'

interface SceneDropDownProps {
  sceneId: string
  context: 'scenes' | 'editDiagram'
  className?: string
  horizontal?: boolean
  buttonColor?: DropdownMenuProps['buttonColor']
  navigation?: 'panels' | 'workspace'
}

function isNotNull<T>(value: T | null): value is T {
  return value !== null
}

export function SceneDropDown({
  sceneId,
  context,
  className,
  horizontal,
  buttonColor,
  navigation = 'panels',
}: SceneDropDownProps) {
  const { frameId } = useValues(frameLogic)
  const { editScene, editSceneJSON } = useActions(frameEditorsLogic)
  const { navigateToScene, openScenePreview } = useActions(workspaceLogic)
  const { scenes, sceneUpdateVersions } = useValues(scenesLogic({ frameId }))
  const { renameScene, duplicateScene, deleteScene, setAsDefault, removeDefault, copySceneJSON, updateSceneFromRepo } =
    useActions(scenesLogic({ frameId }))
  const { saveAsTemplate, saveAsZip } = useActions(templatesLogic({ frameId }))
  const scene = scenes.find((s) => s.id === sceneId)
  if (!scene) {
    return null
  }
  const openSceneEditor = () => {
    if (navigation === 'workspace') {
      navigateToScene(frameId, scene.id)
    } else {
      editScene(scene.id)
    }
  }
  const openSceneJSON = () => {
    if (navigation === 'workspace') {
      openWorkspaceSceneUtility(frameId, scene.id, 'json')
    } else {
      editSceneJSON(scene.id)
    }
  }
  const openSceneSettings = () => {
    if (navigation === 'workspace') {
      openWorkspaceSceneUtility(frameId, scene.id, 'info')
    }
  }

  return (
    <DropdownMenu
      buttonColor={buttonColor ?? 'secondary'}
      className={className}
      horizontal={horizontal}
      items={[
        sceneUpdateVersions[sceneId]
          ? {
              label: 'Update scene',
              confirm:
                'Update this scene to the latest version from the repository? Any local changes to the scene will be replaced.',
              onClick: () => updateSceneFromRepo(scene.id),
              icon: <ArrowPathIcon className="w-5 h-5" />,
            }
          : null,
        context === 'scenes'
          ? {
              label: 'Preview',
              onClick: () => openScenePreview(frameId, scene.id),
              icon: <PlayIcon className="w-5 h-5" />,
            }
          : null,
        context === 'scenes' && navigation === 'workspace'
          ? {
              label: 'Scene settings',
              onClick: openSceneSettings,
              icon: <Cog6ToothIcon className="w-5 h-5" />,
            }
          : null,
        context === 'scenes'
          ? {
              label: 'Edit scene',
              onClick: openSceneEditor,
              icon: <PencilSquareIcon className="w-5 h-5" />,
            }
          : null,
        context === 'scenes'
          ? {
              label: 'Edit scene JSON',
              onClick: openSceneJSON,
              icon: <DocumentMagnifyingGlassIcon className="w-5 h-5" />,
            }
          : null,
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

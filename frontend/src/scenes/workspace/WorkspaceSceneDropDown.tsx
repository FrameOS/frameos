import { BindLogic, useActions, useValues } from 'kea'
import { useState, type FormEvent } from 'react'
import { v4 as uuidv4 } from 'uuid'
import {
  ArrowPathIcon,
  ClipboardDocumentIcon,
  CloudArrowDownIcon,
  CloudArrowUpIcon,
  DocumentDuplicateIcon,
  DocumentMagnifyingGlassIcon,
  FolderPlusIcon,
  TagIcon,
} from '@heroicons/react/24/outline'
import { FlagIcon, PencilSquareIcon, PlayIcon, TrashIcon } from '@heroicons/react/24/solid'

import { DropdownMenu, type DropdownMenuProps } from '../../components/DropdownMenu'
import { Modal } from '../../components/Modal'
import { TextInput } from '../../components/TextInput'
import type { FrameScene, FrameType } from '../../types'
import { frameLogic } from '../frame/frameLogic'
import { sceneUpdatesLogic } from '../frame/panels/Scenes/sceneUpdatesLogic'
import { findConnectedScenes } from '../frame/panels/Scenes/utils'
import { EditTemplateModal } from '../frame/panels/Templates/EditTemplateModal'
import { cloudDriveLogic } from '../frame/panels/Templates/cloudDriveLogic'
import { templatesLogic } from '../frame/panels/Templates/templatesLogic'
import { openWorkspaceSceneUtility, workspaceLogic } from './workspaceLogic'

interface WorkspaceSceneDropDownProps {
  frame: FrameType
  scene: FrameScene
  scenes: FrameScene[]
  className?: string
  horizontal?: boolean
  buttonColor?: DropdownMenuProps['buttonColor']
}

export function WorkspaceSceneDropDown({
  frame,
  scene,
  scenes,
  className,
  horizontal,
  buttonColor,
}: WorkspaceSceneDropDownProps): JSX.Element {
  const [renameName, setRenameName] = useState<string | null>(null)
  const [templateModalMounted, setTemplateModalMounted] = useState(false)
  const { frameForm } = useValues(frameLogic({ frameId: frame.id }))
  const { setFrameFormValues } = useActions(frameLogic({ frameId: frame.id }))
  // sceneUpdatesLogic and not scenesLogic: this dropdown renders on the frames
  // home, and scenesLogic would mount controlLogic, which fetches frame state.
  const { sceneUpdateVersions } = useValues(sceneUpdatesLogic({ frameId: frame.id }))
  const { updateSceneFromRepo } = useActions(sceneUpdatesLogic({ frameId: frame.id }))
  const { navigateToScene, openScenePreview } = useActions(workspaceLogic)
  const { saveAsTemplate, saveAsZip, saveAsCloudTemplate } = useActions(templatesLogic({ frameId: frame.id }))
  const { hasDriveScope } = useValues(cloudDriveLogic)
  const currentScenes = frameForm.scenes ?? frame.scenes ?? scenes
  const currentScene = currentScenes.find((candidate) => candidate.id === scene.id) ?? scene

  const updateScenes = (nextScenes: FrameScene[]): void => {
    setFrameFormValues({ scenes: nextScenes })
  }

  const connectedSceneIds = (): string[] => findConnectedScenes(currentScenes, scene.id)

  const submitRename = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const nextName = renameName?.trim()
    if (!nextName || nextName === currentScene.name) {
      return
    }
    updateScenes(
      currentScenes.map((candidate) => (candidate.id === scene.id ? { ...candidate, name: nextName } : candidate))
    )
    setRenameName(null)
  }

  return (
    <>
      <DropdownMenu
        buttonColor={buttonColor ?? 'secondary'}
        className={className}
        horizontal={horizontal}
        items={[
          ...(sceneUpdateVersions[scene.id]
            ? [
                {
                  label: 'Update scene',
                  confirm:
                    'Update this scene to the latest version from the repository? Any local changes to the scene will be replaced.',
                  onClick: () => updateSceneFromRepo(scene.id),
                  icon: <ArrowPathIcon className="h-5 w-5" />,
                },
              ]
            : []),
          {
            label: 'Preview',
            onClick: () => openScenePreview(frame.id, scene.id),
            icon: <PlayIcon className="h-5 w-5" />,
          },
          {
            label: 'Edit scene',
            onClick: () => navigateToScene(frame.id, scene.id),
            icon: <PencilSquareIcon className="h-5 w-5" />,
          },
          {
            label: 'Edit scene JSON',
            onClick: () => openWorkspaceSceneUtility(frame.id, scene.id, 'json'),
            icon: <DocumentMagnifyingGlassIcon className="h-5 w-5" />,
          },
          {
            label: 'Copy scene JSON',
            onClick: () => navigator.clipboard.writeText(JSON.stringify(currentScene)),
            icon: <ClipboardDocumentIcon className="h-5 w-5" />,
          },
          {
            label: 'Save to "My scenes"',
            onClick: () => {
              setTemplateModalMounted(true)
              saveAsTemplate({ name: currentScene.name ?? '', exportScenes: connectedSceneIds() })
            },
            icon: <FolderPlusIcon className="h-5 w-5" />,
          },
          {
            label: 'Save to cloud drive',
            onClick: () => {
              if (!hasDriveScope) {
                window.alert(
                  'FrameOS Cloud is not connected (or store publishing is disabled). Enable it under Settings → FrameOS Cloud.'
                )
                return
              }
              setTemplateModalMounted(true)
              saveAsCloudTemplate({ name: currentScene.name ?? '', exportScenes: connectedSceneIds() })
            },
            icon: <CloudArrowUpIcon className="h-5 w-5" />,
          },
          {
            label: 'Download as .zip',
            onClick: () => {
              setTemplateModalMounted(true)
              saveAsZip({ name: currentScene.name ?? '', exportScenes: connectedSceneIds() })
            },
            icon: <CloudArrowDownIcon className="h-5 w-5" />,
          },
          {
            label: 'Duplicate',
            onClick: () => updateScenes([...currentScenes, { ...currentScene, default: false, id: uuidv4() }]),
            icon: <DocumentDuplicateIcon className="h-5 w-5" />,
          },
          {
            label: 'Rename',
            onClick: () => setRenameName(currentScene.name ?? ''),
            icon: <TagIcon className="h-5 w-5" />,
          },
          currentScene.default
            ? {
                label: 'Remove "start on boot"',
                onClick: () =>
                  updateScenes(
                    currentScenes.map((candidate) => {
                      if ('default' in candidate) {
                        const { default: _, ...rest } = candidate
                        return rest
                      }
                      return candidate
                    })
                  ),
                icon: <FlagIcon className="h-5 w-5" />,
              }
            : {
                label: 'Set to start on boot',
                onClick: () =>
                  updateScenes(
                    currentScenes.map((candidate) =>
                      candidate.id === scene.id
                        ? { ...candidate, default: true }
                        : candidate.default
                        ? { ...candidate, default: false }
                        : candidate
                    )
                  ),
                icon: <FlagIcon className="h-5 w-5" />,
              },
          {
            label: 'Delete scene',
            confirm: 'Are you sure you want to delete this scene?',
            onClick: () => updateScenes(currentScenes.filter((candidate) => candidate.id !== scene.id)),
            icon: <TrashIcon className="h-5 w-5" />,
          },
        ]}
      />
      {renameName !== null ? (
        <Modal open onClose={() => setRenameName(null)} title="Rename scene">
          <form onSubmit={submitRename} className="space-y-4 p-5">
            <label className="block">
              <span className="frameos-muted mb-2 block text-sm font-semibold">Scene name</span>
              <TextInput autoFocus value={renameName} onChange={setRenameName} />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenameName(null)}
                className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!renameName.trim() || renameName.trim() === currentScene.name}
                className="frameos-primary-action rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Rename
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
      {templateModalMounted ? (
        <BindLogic logic={frameLogic} props={{ frameId: frame.id }}>
          <EditTemplateModal />
        </BindLogic>
      ) : null}
    </>
  )
}

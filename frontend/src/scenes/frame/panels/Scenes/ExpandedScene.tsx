import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useActions, useValues } from 'kea'
import { router } from 'kea-router'
import { expandedSceneLogic } from './expandedSceneLogic'
import { Form } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { Button } from '../../../../components/Button'
import { controlLogic } from './controlLogic'
import { sceneIsActivating } from '../../../../utils/sceneActivation'
import { frameEditorsLogic } from '../../frameEditorsLogic'
import { StateFieldEdit } from './StateFieldEdit'
import { FrameScene, FrameId } from '../../../../types'
import { scenesLogic } from './scenesLogic'
import { frameLogic } from '../../frameLogic'
import { isCloudMode } from '../../../../utils/cloudMode'
import { scenePushActionCopy } from '../../../../utils/scenePush'
import { sceneIdsRefer } from '../../../../utils/systemScenes'
import { PlayIcon, EyeIcon } from '@heroicons/react/24/solid'
import { WindowIcon } from '@heroicons/react/24/outline'
import { isInFrameAdminMode } from '../../../../utils/frameAdmin'
import { livePreviewLogic, LIVE_PREVIEW_HASH_KEY } from './livePreviewLogic'
import { LivePreviewModal } from './LivePreviewModal'
import { SceneActionsButton, SceneActionOption } from './SceneActionsButton'
import { SceneActionKey } from './sceneActionsLogic'
import { confirmDialog } from '../../../../utils/confirmDialogLogic'

export interface ExpandedSceneProps {
  sceneId: string
  frameId: FrameId
  scene?: FrameScene | null
  showEditButton?: boolean
  isUnsaved?: boolean
  isUndeployed?: boolean
  /** Where to render the action buttons (Activate, Reset) instead of under the
   * fields: the scene drawer's fixed footer. `null` is a footer not mounted
   * yet (nothing renders until it is); leave it out to keep them inline. */
  actionsContainer?: HTMLElement | null
}

export function ExpandedScene({
  frameId,
  sceneId,
  scene,
  showEditButton = true,
  isUnsaved,
  isUndeployed,
  actionsContainer,
}: ExpandedSceneProps) {
  const { stateChanges, visibleFields } = useValues(expandedSceneLogic({ frameId, sceneId, scene }))
  const { states, sceneId: currentSceneId, activatingSceneId } = useValues(controlLogic({ frameId }))
  const { changedScenes } = useValues(frameLogic({ frameId }))
  const { undeployedSceneIds, unsavedSceneIds, scenePushIds } = useValues(scenesLogic({ frameId }))
  const { submitStateChanges, resetStateChanges } = useActions(expandedSceneLogic({ frameId, sceneId, scene }))
  const { previewScene, deleteScene, pushScene } = useActions(scenesLogic({ frameId }))
  const { openLivePreview } = useActions(livePreviewLogic({ frameId }))
  const { livePreviewSceneId } = useValues(livePreviewLogic({ frameId }))
  const { editScene } = useActions(frameEditorsLogic)
  const fieldCount = visibleFields.length
  const frameAdminMode = isInFrameAdminMode()

  // Reopen the in-browser preview after a reload: openLivePreview stores the
  // scene id in the URL hash, and by the time this card is mounted the frame's
  // scenes are guaranteed to be loaded.
  useEffect(() => {
    if (router.values.hashParams[LIVE_PREVIEW_HASH_KEY] === sceneId && livePreviewSceneId !== sceneId) {
      openLivePreview(sceneId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const currentState = states[sceneId] ?? {}
  const sceneIsUndeployed = isUndeployed ?? undeployedSceneIds.has(sceneId)
  const sceneIsUnsaved = isUnsaved ?? changedScenes.has(sceneId)
  const sceneHasChanges = sceneIsUnsaved || sceneIsUndeployed
  const canPreviewUnsavedChanges = sceneHasChanges && !frameAdminMode
  // Spins from the click until the frame logs this scene's render:done —
  // the request being accepted says nothing about the panel yet.
  const activating = sceneIsActivating(activatingSceneId, sceneId)
  // With changes the main action is a push (docs/ui-vocabulary.md): this
  // scene and the connected scenes that changed. "Apply to active scene"
  // used to stay on the active scene even then, and read as if the edits
  // would not go out.
  const sceneIsCurrent = sceneIdsRefer(sceneId, currentSceneId)
  const pushSceneIds = sceneHasChanges ? scenePushIds(sceneId) : []
  const pushCopy = scenePushActionCopy({
    active: sceneIsCurrent,
    connected: pushSceneIds.filter((id) => id !== sceneId).length,
    saves: !isCloudMode() && (sceneIsUnsaved || pushSceneIds.some((id) => unsavedSceneIds.has(id))),
  })
  const activateLabel = activating
    ? 'Activating…'
    : frameAdminMode && sceneHasChanges
    ? 'Save & activate scene'
    : sceneHasChanges
    ? pushCopy.label
    : sceneIsCurrent
    ? 'Apply to active scene'
    : 'Activate scene'
  const activateDescription =
    frameAdminMode && sceneHasChanges
      ? 'Save your changes and make this the active scene'
      : sceneHasChanges
      ? pushCopy.description
      : 'Make this the active scene on the frame'

  const buildNextState = (): Record<string, any> => {
    const desiredState = { ...currentState, ...stateChanges }
    const state: Record<string, any> = {}
    for (const field of visibleFields) {
      if (!field.name) {
        continue
      }
      const value = desiredState[field.name] ?? field.value
      if (value !== undefined && value !== null) {
        state[field.name] = String(value)
      }
    }
    return state
  }

  const handlePreview = () => {
    previewScene(sceneId, buildNextState())
  }

  const handleActivate = async () => {
    if (frameAdminMode) {
      if (sceneIsUnsaved) {
        await frameLogic({ frameId }).asyncActions.saveFrame()
      }
      previewScene(sceneId, buildNextState())
      return
    }

    if (sceneHasChanges) {
      pushScene(sceneId, true, buildNextState())
    } else {
      submitStateChanges()
    }
  }

  const handleDelete = () => {
    void confirmDialog({
      title: 'Delete this scene?',
      message: 'The scene is removed from this frame on the next save. This cannot be undone.',
      confirmLabel: 'Delete scene',
      danger: true,
    }).then((confirmed) => {
      if (confirmed) {
        deleteScene(sceneId)
      }
    })
  }

  const actionOptions: SceneActionOption[] = [
    {
      key: 'activate',
      label: activateLabel,
      description: activateDescription,
      icon: <PlayIcon className="h-4 w-4 shrink-0" />,
      loading: activating,
      onRun: () => void handleActivate(),
    },
    {
      key: 'preview-frame',
      label: 'Preview on frame',
      description: 'Temporarily show this scene on the frame, without saving or pushing',
      icon: <EyeIcon className="h-4 w-4 shrink-0" />,
      onRun: handlePreview,
    },
    {
      key: 'preview-browser',
      label: 'Preview in browser',
      description: 'Run this scene in your browser via WebAssembly',
      icon: <WindowIcon className="h-4 w-4 shrink-0" />,
      onRun: () => openLivePreview(sceneId, buildNextState()),
    },
  ]
  // Matches the old standalone buttons: with unsaved/undeployed changes the
  // primary action was the on-frame preview, otherwise activate.
  const defaultActionKey: SceneActionKey = canPreviewUnsavedChanges ? 'preview-frame' : 'activate'
  // Under the fields, or in the drawer's footer: portaled there, but still
  // inside this card's Form in the React tree.
  const placeActions = (actions: JSX.Element, inline: JSX.Element): JSX.Element | null =>
    actionsContainer === undefined ? inline : actionsContainer ? createPortal(actions, actionsContainer) : null
  const resetButton = (
    <Button onClick={() => resetStateChanges()} color="secondary">
      Reset
    </Button>
  )

  return (
    <div className="space-y-3">
      {showEditButton ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button onClick={() => editScene(sceneId)} color="secondary">
            Open editor
          </Button>
          <Button onClick={handleDelete} color="red">
            Delete
          </Button>
        </div>
      ) : null}
      {fieldCount === 0 ? (
        placeActions(
          <SceneActionsButton options={actionOptions} defaultKey={defaultActionKey} />,
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <SceneActionsButton options={actionOptions} defaultKey={defaultActionKey} />
            </div>
          </div>
        )
      ) : (
        <Form
          logic={expandedSceneLogic}
          props={{ frameId, sceneId }}
          formKey="stateChanges"
          className="space-y-2 @container"
        >
          {visibleFields.map((field) => (
            <Field
              key={field.name}
              name={field.name}
              label={
                <>
                  {field.label || field.name}
                  {field.name in stateChanges && stateChanges[field.name] !== (currentState[field.name] ?? field.value)
                    ? ' (modified)'
                    : ''}
                </>
              }
            >
              {({ value, onChange }) => (
                <StateFieldEdit
                  field={field}
                  value={value}
                  onChange={onChange}
                  currentState={currentState}
                  stateChanges={stateChanges}
                  frameId={frameId}
                />
              )}
            </Field>
          ))}
          {placeActions(
            <div className="flex w-full flex-wrap items-center gap-2">
              <SceneActionsButton options={actionOptions} defaultKey={defaultActionKey} />
              {resetButton}
            </div>,
            <div className="flex w-full items-center gap-2">
              <div className="@md:w-1/3 hidden @md:block" />
              <div className="flex w-full flex-wrap items-center gap-2">
                <SceneActionsButton options={actionOptions} defaultKey={defaultActionKey} />
                {resetButton}
              </div>
            </div>
          )}
        </Form>
      )}
      {livePreviewSceneId === sceneId ? <LivePreviewModal frameId={frameId} /> : null}
    </div>
  )
}

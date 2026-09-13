import { useActions, useValues } from 'kea'
import clsx from 'clsx'

import { DropdownMenu } from '../../components/DropdownMenu'
import { Switch } from '../../components/Switch'
import type { FrameId } from '../../types'
import {
  sceneDependencyGroupingDisabledPath,
  sceneDependencyGroupingIsEnabled,
  statusScreenHiddenPath,
  statusScreenIsShown,
  type SceneDependencyGroupingSurface,
  workspaceLogic,
} from './workspaceLogic'

interface SceneDependencyFormatMenuProps {
  frameId: FrameId
  surface: SceneDependencyGroupingSurface
  className?: string
  multiSelect?: {
    enabled: boolean
    onToggle: (enabled: boolean) => void
  }
  /** Offer "Show status screen". Absent where the frame has no such scene. */
  statusScreen?: boolean
}

export function SceneDependencyFormatMenu({
  frameId,
  surface,
  className,
  multiSelect,
  statusScreen,
}: SceneDependencyFormatMenuProps): JSX.Element {
  const { frameAssetFolderExpansion } = useValues(workspaceLogic)
  const { setFrameAssetFolderExpanded } = useActions(workspaceLogic)
  const groupingEnabled = sceneDependencyGroupingIsEnabled(frameAssetFolderExpansion, frameId, surface)
  const statusScreenShown = statusScreenIsShown(frameAssetFolderExpansion, frameId, surface)

  return (
    <DropdownMenu
      buttonColor="secondary"
      buttonTitle="Scene list display"
      className={clsx('h-8 w-8 items-center !rounded-lg !px-0 !py-0', className)}
      items={[
        {
          content: () => (
            <Switch
              label="Group dependent scenes"
              value={groupingEnabled}
              onChange={(enabled) =>
                setFrameAssetFolderExpanded(frameId, sceneDependencyGroupingDisabledPath(surface), !enabled)
              }
              fullWidth
            />
          ),
        },
        ...(statusScreen
          ? [
              {
                content: () => (
                  <Switch
                    label="Show status screen"
                    value={statusScreenShown}
                    onChange={(shown) =>
                      setFrameAssetFolderExpanded(frameId, statusScreenHiddenPath(surface), !shown)
                    }
                    fullWidth
                  />
                ),
              },
            ]
          : []),
        ...(multiSelect
          ? [
              {
                content: () => (
                  <Switch
                    label="Select multiple scenes"
                    value={multiSelect.enabled}
                    onChange={(enabled) => multiSelect.onToggle(enabled)}
                    fullWidth
                  />
                ),
              },
            ]
          : []),
      ]}
    />
  )
}

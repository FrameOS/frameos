import { useActions, useValues } from 'kea'
import clsx from 'clsx'

import { DropdownMenu } from '../../components/DropdownMenu'
import { Switch } from '../../components/Switch'
import {
  sceneDependencyGroupingDisabledPath,
  sceneDependencyGroupingIsEnabled,
  type SceneDependencyGroupingSurface,
  workspaceLogic,
} from './workspaceLogic'

interface SceneDependencyFormatMenuProps {
  frameId: number
  surface: SceneDependencyGroupingSurface
  className?: string
}

export function SceneDependencyFormatMenu({
  frameId,
  surface,
  className,
}: SceneDependencyFormatMenuProps): JSX.Element {
  const { frameAssetFolderExpansion } = useValues(workspaceLogic)
  const { setFrameAssetFolderExpanded } = useActions(workspaceLogic)
  const groupingEnabled = sceneDependencyGroupingIsEnabled(frameAssetFolderExpansion, frameId, surface)

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
      ]}
    />
  )
}
